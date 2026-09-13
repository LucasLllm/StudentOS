import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { LlmProvider } from '@contexto/llm';
import { untrustedNote } from '../untrusted.js';
import { courseForFolder } from './collapse.js';
import { courseTitles, type DriveFile, type DriveVerdict } from './drive.js';
import { retrying } from './retry.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * Deciding about every file in a Drive, not only the ones in a course folder.
 *
 * A student who connects Drive has handed over the whole of it -- full read
 * access comes with the connection -- and a folder that names a course places
 * only a fraction of what is there. The rest used to be thrown away unread: a
 * CAS brainstorming document, an application, revision with no folder, along
 * with the photographs and the music the rule was written to keep out.
 *
 * So the rest is judged, on what the listing says about each file: its name,
 * what kind of thing it is, whose it is, where it sits, when it last changed.
 * Fifty at a time, against the student's courses and what is known about
 * their school, so "CAS" means something. Reading a file to decide about it
 * would be a model call per file for the whole Drive; the listing is enough
 * to tell a study guide from a holiday album, and what stays is read anyway
 * by the pass that writes its sentence.
 *
 * A verdict is kept. A file is asked about once, and again only when it has
 * changed -- otherwise a Drive of five hundred files is ten model calls on
 * every refresh for ever, to reach the same answers.
 */

export interface DriveTriageDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface DriveTriageOptions {
  vault: Vault;
  /** The whole listing. What needs no judging is passed over here. */
  files: DriveFile[];
  /** ISO date. A model has no clock. */
  today: string;
  /** ISO date this school year began. Nothing changed before the year before it is judged. */
  yearStart: string;
  /** The school page, where one has been written. It names the programmes a file may be for. */
  school?: string;
  /** The courses the filter dropped this build: last year's subjects, by title. */
  dropped?: string[];
  /** The student's current grade, where the vault knows it. "Grade 10" in a name is then last year's. */
  grade?: number;
  userId: string;
}

/** How many files one question is about. */
const BATCH = 50;

/** Where the verdicts live: beside the notes, not among them. */
const LEDGER = 'drive-judged.json';

/**
 * Which rule the remembered verdicts were given under.
 *
 * A verdict is an answer to a question, and when the question changes the
 * answer is stale. Bumping this sets every remembered verdict aside, so each
 * file is asked about once more under the new rule and then remembered again.
 *
 *   1  the first rule: is this about school at all
 *   2  and no subject work from past years; temporary and system files out
 */
const RULE = 2;

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

/**
 * Files that are not a person's work at all: editor lock files, temporary
 * files, the folder metadata desktop systems leave behind. Refused without a
 * question, since no rule about schooling applies to them.
 */
const JUNK =
  /^(?:~|\.DS_Store$|desktop\.ini$|Thumbs\.db$|\.localized$)|\.(?:tmp|crdownload|part)$/i;

/** What is remembered per file: the verdict, and the change time it was given for. */
export type DriveLedger = Record<string, DriveVerdict & { modifiedAt: string }>;

/**
 * Where a file stands before anybody is asked about it.
 *
 * One rule, shared by the judge and by the script that explains the judge,
 * so the two cannot disagree about why a file is where it is.
 */
export type DriveStanding =
  /** A folder or a shortcut: structure, not content. */
  | { why: 'not-a-file' }
  /** Classroom already gave us this one, and knows more about it. */
  | { why: 'classroom' }
  /** A lock file, a temporary file, a desktop's own bookkeeping. */
  | { why: 'junk' }
  /** A folder on its path names a course the student takes. */
  | { why: 'folder'; course: string }
  /** Last changed before last school year began. Nothing that old is kept. */
  | { why: 'too-old' }
  /** Asked about before, and unchanged since. */
  | { why: 'remembered'; verdict: DriveVerdict }
  /** Nobody has judged it yet, or it has changed since somebody did. */
  | { why: 'unjudged' };

export function standingOf(
  file: DriveFile,
  {
    known,
    courses,
    lastYearBegan,
    ledger,
  }: {
    /** File id to the source of the note that already carries it. */
    known: ReadonlyMap<string, string>;
    courses: ReadonlyMap<string, string>;
    lastYearBegan: string;
    ledger: DriveLedger;
  },
): DriveStanding {
  if (file.mimeType === FOLDER || file.mimeType === SHORTCUT) return { why: 'not-a-file' };
  // A note from Drive is judged again like any other; one from Classroom is Classroom's.
  const source = known.get(file.fileId);
  if (source !== undefined && source !== 'drive') return { why: 'classroom' };
  if (JUNK.test(file.name.trim())) return { why: 'junk' };

  const filed = (file.path ?? [])
    .map((folder) => courseForFolder(folder, courses))
    .find((course): course is string => course !== null);
  if (filed) return { why: 'folder', course: filed };

  if (file.modifiedAt && file.modifiedAt.slice(0, 10) < lastYearBegan) return { why: 'too-old' };

  const remembered = ledger[file.fileId];
  if (remembered && remembered.modifiedAt === (file.modifiedAt ?? '')) {
    return { why: 'remembered', verdict: { keep: remembered.keep, course: remembered.course } };
  }
  return { why: 'unjudged' };
}

/** Every file the vault already holds a note for, and where that note came from. */
export function knownFiles(existing: readonly VaultNote[]): Map<string, string> {
  const known = new Map<string, string>();
  for (const note of existing) if (note.externalId) known.set(note.externalId, note.source);
  return known;
}

/** The date the year before this one began. Last year is as far back as anything is kept. */
export function yearBeforeStart(yearStart: string): string {
  return `${Number(yearStart.slice(0, 4)) - 1}${yearStart.slice(4)}`;
}

const verdicts = z.object({
  files: z
    .array(
      z.object({
        file: z.coerce.number().int(),
        keep: z.boolean(),
        inCourse: z.string().nullish(),
      }),
    )
    .default([]),
});

const ASK = [
  'You are reading a list of files from one student’s Google Drive, and deciding which',
  'of them belong in the notes their study agent keeps about their schooling.',
  '',
  'Reply with JSON only, no prose around it:',
  '{"files": [{"file": number, "keep": boolean, "inCourse": string | null}]}',
  '',
  'file is the NUMBER the file is listed under, never its name. Answer for every number.',
  '',
  'keep is true for anything about their schooling now: this year’s coursework, essays,',
  'revision and study guides, notes, projects, lab work and presentations; applications',
  'and personal statements; anything for a programme, a club, a team or a competition',
  'the school runs, this year or last; and anything a teacher shared with them for a',
  'current room. It is false for the rest of a Drive: photographs, music, videos, games,',
  'downloads, receipts, personal writing.',
  '',
  'It is also false for SUBJECT WORK FROM A PAST YEAR. A subject ends when its year',
  'ends: slides, worksheets, study guides, exam reviews and essays for a subject the',
  'student took last year or earlier are out, however good they are, unless that',
  'subject is one of the current rooms listed. You are told which subjects are over',
  'and what grade the student is in now; work labelled with a lower grade is a past',
  'year’s. Where a file already has a line saying what the reader found in it, trust',
  'that over the name. Clubs, teams and programmes are not subjects and do not end.',
  '',
  'When a name could be either, keep it -- what stays is read properly later, and a',
  'study guide left out is gone for good. That does not apply to a past year’s subject',
  'work: leave it out.',
  '',
  'inCourse is the ONE entry on the list you are given that the file plainly belongs to,',
  'copied exactly, or null. The list is every room the student has on Classroom, and',
  'that includes clubs, teams, houses and programmes as well as subjects -- so a robotics',
  'team’s supply list belongs to the robotics room, and a business club’s pitch belongs',
  'to the club. Null when nothing on the list fits, which is common: a personal statement',
  'or a CAS plan is for a programme with no room of its own. A wrong match is worse than',
  'none. Never invent an entry, and never use a name that is not on the list.',
].join('\n');

/**
 * Which files stay, and under what, for everything a folder did not place.
 *
 * Returns a verdict for every listed file that has one -- remembered or fresh.
 * A file with no verdict is one nobody has judged yet, and the importer leaves
 * it for the next refresh rather than reading silence as an answer.
 */
export async function judgeDriveFiles(
  { llm }: DriveTriageDeps,
  { vault, files, today, yearStart, school, dropped, grade, userId }: DriveTriageOptions,
): Promise<Map<string, DriveVerdict>> {
  const existing = await vault.list('entity');
  const known = knownFiles(existing);
  const courses = courseTitles(existing);
  const lastYearBegan = yearBeforeStart(yearStart);

  /*
   * What the reader found in a file the vault already holds.
   *
   * A file kept on its name and then opened has a sentence saying what it is,
   * and that sentence is the best evidence there is: "Unit 4" says nothing,
   * "This 10 Science slide deck" says everything. Asked about again, the
   * model sees it.
   */
  const found = new Map<string, string>();
  for (const note of existing) {
    if (note.source !== 'drive' || !note.externalId) continue;
    const said = /^## What is in it[^\n]*\n\n(.+)$/m.exec(note.body)?.[1]?.trim();
    if (said) found.set(note.externalId, said);
  }

  const ledger = await readLedger(vault);
  const judged = new Map<string, DriveVerdict>();
  const asking: DriveFile[] = [];

  for (const file of files) {
    const standing = standingOf(file, { known, courses, lastYearBegan, ledger });
    if (standing.why === 'remembered') judged.set(file.fileId, standing.verdict);
    else if (standing.why === 'too-old' || standing.why === 'junk') {
      // Decided by the rule, not the model, and cheap enough to decide every time.
      judged.set(file.fileId, { keep: false, course: null });
    } else if (standing.why === 'unjudged') asking.push(file);
  }

  let changed = false;
  for (let at = 0; at < asking.length; at += BATCH) {
    const batch = asking.slice(at, at + BATCH);
    const said = await ask(llm, { batch, courses, today, school, dropped, grade, found, userId });
    for (const [listedAs, verdict] of said) {
      const file = batch[listedAs - 1];
      if (!file) continue;
      judged.set(file.fileId, verdict);
      ledger[file.fileId] = { ...verdict, modifiedAt: file.modifiedAt ?? '' };
      changed = true;
    }
  }

  if (changed) await writeLedger(vault, ledger);
  return judged;
}

/** One batch, asked once. An answer that cannot be read is no answer. */
async function ask(
  llm: Pick<LlmProvider, 'chat'>,
  {
    batch,
    courses,
    today,
    school,
    dropped,
    grade,
    found,
    userId,
  }: {
    batch: DriveFile[];
    courses: ReadonlyMap<string, string>;
    today: string;
    school: string | undefined;
    dropped: string[] | undefined;
    grade: number | undefined;
    found: ReadonlyMap<string, string>;
    userId: string;
  },
): Promise<Map<number, DriveVerdict>> {
  const listed = [
    '<untrusted>',
    untrustedNote('The files below are named by whoever made them.'),
    '',
    batch.map((file, index) => describe(file, index + 1, found.get(file.fileId))).join('\n'),
    '</untrusted>',
  ].join('\n');

  const answers = new Map<number, DriveVerdict>();
  try {
    const response = await retrying(() =>
      llm.chat(
        {
          // Background work the student never waits on; medium is enough for a page
          // and a fifth of the reasoning bill.
          effort: 'medium',
          messages: [
            { role: 'system', content: ASK },
            {
              role: 'user',
              content: [
                `Today is ${today}.` +
                  (grade === undefined ? '' : ` The student is in Grade ${grade} now.`),
                '',
                'The rooms the student has on Classroom now, the only names inCourse may use:',
                ...[...courses.keys()].map((title) => `- ${defang(title)}`),
                ...(dropped && dropped.length > 0
                  ? [
                      '',
                      'Subjects that are over -- last year’s or earlier. Work for these is out:',
                      ...dropped.map((title) => `- ${defang(title)}`),
                    ]
                  : []),
                ...(school
                  ? [
                      '',
                      'What is known about the school, which may name its programmes and clubs:',
                      '',
                      school,
                    ]
                  : []),
                '',
                'The files:',
                listed,
              ].join('\n'),
            },
          ],
        },
        { userId },
      ),
    );

    for (const said of parse(response.content)?.files ?? []) {
      // A course off the list is a guess, and a guess is worse than no subject.
      const course = said.inCourse ? (courses.get(said.inCourse) ?? null) : null;
      answers.set(said.file, { keep: said.keep, course: said.keep ? course : null });
    }
  } catch {
    // Left unjudged, for the next refresh. See the note on silence above.
  }
  return answers;
}

/** One file, as much as a listing knows about it, and what the reader found if it has looked. */
function describe(file: DriveFile, listedAs: number, about?: string): string {
  const facts = [
    driveKind(file.mimeType),
    file.ownedByStudent ? 'theirs' : file.owner ? `shared by ${defang(file.owner)}` : 'shared',
    ...(file.path && file.path.length > 0 ? [`in ${defang(file.path.join('/'))}`] : []),
    ...(file.modifiedAt ? [`changed ${file.modifiedAt.slice(0, 10)}`] : []),
  ];
  return (
    `${listedAs}. ${defang(file.name)} -- ${facts.join(', ')}` +
    (about ? `\n   what the reader found: ${defang(about).replace(/\s+/g, ' ').slice(0, 240)}` : '')
  );
}

export function driveKind(mimeType: string): string {
  if (mimeType === 'application/vnd.google-apps.document') return 'document';
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'spreadsheet';
  if (mimeType === 'application/vnd.google-apps.presentation') return 'slides';
  if (mimeType === 'application/vnd.google-apps.form') return 'form';
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('text/')) return 'text file';
  return mimeType.split('/').pop() || 'file';
}

/** Angle brackets folded, so nothing a file is called can close the wrapper. */
function defang(text: string): string {
  return text.replaceAll('<', '‹').replaceAll('>', '›');
}

function parse(content: unknown): z.infer<typeof verdicts> | null {
  if (typeof content !== 'string') return null;
  const text = content.trim().replace(/^```(?:json)?\s*/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = verdicts.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Remember some files as out, on somebody else's say-so.
 *
 * The reader opens a kept file and finds it blank; that verdict has to reach
 * the ledger, or the next refresh judges the name again, keeps it again, and
 * reads it again. Only files in the listing, since the entry is keyed to the
 * time the file last changed: if it changes, it is asked about afresh.
 */
export async function rememberDriveFilesOut(
  vault: Vault,
  listed: readonly DriveFile[],
  fileIds: readonly string[],
): Promise<void> {
  if (fileIds.length === 0) return;
  const ledger = await readLedger(vault);
  const byId = new Map(listed.map((file) => [file.fileId, file]));
  for (const id of fileIds) {
    const file = byId.get(id);
    if (file) ledger[id] = { keep: false, course: null, modifiedAt: file.modifiedAt ?? '' };
  }
  await writeLedger(vault, ledger);
}

export async function readLedger(vault: Vault): Promise<DriveLedger> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(vault.directory, LEDGER), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const { rule, files } = parsed as { rule?: unknown; files?: unknown };
    // Verdicts from another rule, or from before rules were numbered, are set aside.
    if (rule !== RULE || !files || typeof files !== 'object') return {};
    return files as DriveLedger;
  } catch {
    // Missing, or unreadable: either way nothing is remembered.
    return {};
  }
}

async function writeLedger(vault: Vault, ledger: DriveLedger): Promise<void> {
  await mkdir(vault.directory, { recursive: true });
  await writeFile(
    join(vault.directory, LEDGER),
    JSON.stringify({ rule: RULE, files: ledger }, null, 2),
  );
}
