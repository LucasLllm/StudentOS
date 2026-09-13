import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { LlmProvider } from '@contexto/llm';
import { USER_DOC } from '../prompts/documents.js';
import {
  CHATS_DOC_NAME,
  CLASS_PREFIX,
  SCHOOL_DOC_NAME,
  USER_DOC_LIMIT,
  USER_DOC_NAME,
  capDocument,
  listDocuments,
  readDocument,
  writeDocument,
} from './documents.js';
import { academicYearEnd } from './school-doc.js';
import { NOTHING_KEPT_YET } from './chats-doc.js';
import { readGrade } from './grade.js';
import { retrying } from './retry.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * What is durably true about a student's school life, on one page.
 *
 * Read before every reply, which decides everything about it. It is short
 * because every character is paid for on every turn for as long as it stays,
 * and it is rewritten whole from the pages beneath it rather than added to,
 * because those are ground truth and a document that accumulates ends up
 * describing a student who left two years ago.
 *
 * It is written last, after the class pages and the school page, because it is
 * written FROM them: it is the index to everything else the agent can open. A
 * subject this page fails to name is a subject the agent never learns exists,
 * which makes an omission here more expensive than anywhere else in the vault.
 *
 * It used to be written from counts, and from claims proposed against bounded
 * evidence and challenged by a pass built to break them. That machinery existed
 * because the facts were scattered across four thousand notes and something had
 * to reconcile them. They are not scattered any more -- each has a page of its
 * own, written from its own evidence -- so this pass reads pages and does no
 * inference at all. The one thing it is handed rather than shown is the year
 * group, because that is arithmetic over dates and is done in code.
 */

/** Kept for the paragraph beside the vault, which every existing vault still has. */
const LEGACY_FILE = 'user.md';

/** Re-exported so nothing outside has to know the budget moved to documents.ts. */
export { USER_DOC_LIMIT };

/**
 * A fingerprint of what the page is written from.
 *
 * The class pages carry their own source hashes, so a page whose notes have
 * not changed reads the same here; the school and chats pages are hashed
 * whole. The date is left out on purpose -- it changes every day and the
 * student does not.
 */
function userDocFingerprint(input: {
  classes: VaultNote[];
  school: VaultNote | undefined;
  chats: VaultNote | undefined;
  student: string | undefined;
  grade: number | null;
}): string {
  const short = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
  const parts = [
    `student:${input.student ?? ''}`,
    `grade:${input.grade ?? ''}`,
    ...input.classes
      .map((doc) => `${doc.name}:${doc.academic ?? ''}:${doc.sourceHash ?? short(doc.body)}`)
      .sort(),
    `school:${input.school ? short(input.school.body) : ''}`,
    `chats:${input.chats ? short(input.chats.body) : ''}`,
  ];
  return short(parts.join('\n'));
}

export interface UserDocDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface UserDocOptions {
  vault: Vault;
  userId: string;
  /** The student's own name, when something knows it. */
  name?: string;
}

/**
 * The document, or null if one has never been written.
 *
 * Two places, for as long as it takes every vault to be rebuilt. The document
 * is where it lives now; the paragraph beside the vault is where every vault on
 * disk still has it. Reading the old one when the new one is empty means an
 * agent keeps knowing who its student is across the deploy, and picks up the
 * fuller page on the next build. The writer removes the old file, so this
 * fallback empties itself.
 */
export async function readUserDoc(vault: Vault): Promise<string | null> {
  const document = await readDocument(vault, USER_DOC_NAME);
  if (document && document.body.trim() !== '') return document.body.trim();

  try {
    const text = await readFile(join(vault.directory, LEGACY_FILE), 'utf8');
    return text.trim() === '' ? null : text.trim();
  } catch {
    return null;
  }
}

export async function writeUserDoc(
  { llm }: UserDocDeps,
  { vault, userId, name }: UserDocOptions,
): Promise<string | null> {
  const documents = await listDocuments(vault);
  const classes = documents.filter((doc) => doc.name.startsWith(CLASS_PREFIX));

  /*
   * Nothing to describe.
   *
   * A student who has connected an account with no courses in it gets no page
   * rather than a page saying nothing, because the two are told apart by
   * whether the file exists.
   */
  if (classes.length === 0) return null;

  const subjects = classes.filter((doc) => doc.academic !== false);
  const others = classes.filter((doc) => doc.academic === false);

  const school = documents.find((doc) => doc.name === SCHOOL_DOC_NAME);
  const chats = documents.find((doc) => doc.name === CHATS_DOC_NAME);

  /*
   * Whose page this is, from the caller or from the last time it was written.
   *
   * The background job that rewrites this when a student says something new
   * does not have their name to hand, and a page that forgets who it is about
   * every time it is rewritten is worse than remembering it here.
   */
  const existing = documents.find((doc) => doc.name === USER_DOC_NAME);
  const student = name ?? existing?.student;

  const today = new Date().toISOString().slice(0, 10);
  const yearEnd = await academicYearEnd(vault);
  const grade = await readGrade(vault, { today, ...(yearEnd ? { yearEnd } : {}) });

  const sourceHash = userDocFingerprint({
    classes,
    school,
    chats,
    student,
    grade: grade?.grade ?? null,
  });
  // Nothing it is written from has changed since it was last written.
  if (existing?.sourceHash === sourceHash) return existing.body;

  const answer = await retrying(() =>
    llm.chat(
      {
        // Background work the student never waits on; medium is enough for a page
        // and a fifth of the reasoning bill.
        effort: 'medium',
        messages: [
          { role: 'system', content: USER_DOC.body },
          {
            role: 'user',
            content: [
              student ? `The student is ${student}.` : "The student's name is not known.",
              /*
               * Handed over, not shown.
               *
               * The evidence in the vault says Grade 10, because that is what it
               * said in March. Counting the years that have ended since is
               * arithmetic, done in code, and a writer given the raw statement
               * would confidently repeat last year's answer all summer.
               */
              grade
                ? `They are in Grade ${grade.grade}.` +
                  (grade.rolledForward > 0
                    ? ` Their mail says Grade ${grade.stated}, from ${grade.on.slice(0, 10)};` +
                      ` ${grade.rolledForward} academic year(s) have ended since, so it is` +
                      ` ${grade.grade} now. Write ${grade.grade}.`
                    : '')
                : 'Which year they are in is not known: do not guess it from a course name.',
              `Today is ${today}.`,
              '',
              /*
               * Sorted for the writer, not left to be inferred.
               *
               * Which of these a student STUDIES and which they merely belong to
               * decides which section each goes in, and it is recorded on the
               * page rather than implied by its prose.
               */
              subjects.length > 0
                ? 'The subjects they are taught, one page each. Link each by the page name shown:'
                : 'They have no taught subjects recorded right now. Say so; do not name one.',
              ...subjects.map((doc) => `- [[${doc.name}]] — ${doc.description}`),
              '',
              ...(others.length > 0
                ? [
                    'Things they do rather than study — clubs, teams, programmes, groups:',
                    ...others.map((doc) => `- [[${doc.name}]] — ${doc.description}`),
                  ]
                : []),
              '',
              school
                ? `Their school has a page, [[${school.name}]]: ${school.description}`
                : 'No school page has been written: do not name a school.',
              chats && chats.body.trim() !== NOTHING_KEPT_YET
                ? `What they have told you is on [[${chats.name}]]: ${chats.description}`
                : 'Nothing has been kept from their conversations yet. There is a page for it' +
                  ' and it is empty, so leave that section out rather than linking to nothing.',
              '',
              `The page may be at most ${USER_DOC_LIMIT} characters.`,
            ].join('\n'),
          },
        ],
      },
      { userId },
    ),
  );

  const body = capDocument(
    typeof answer.content === 'string' ? answer.content : '',
    USER_DOC_LIMIT,
  );
  /*
   * A blank answer must not blank the page.
   *
   * The agent would carry on with no idea who this student is, and nothing
   * would say why -- an empty file and a file that was never written look the
   * same from the outside.
   */
  if (body === '') return readUserDoc(vault);

  await writeDocument(vault, {
    name: USER_DOC_NAME,
    description: 'Who this student is, and what else there is to open',
    body,
    sourceHash,
    ...(student ? { student } : {}),
  });

  /*
   * And take the old paragraph away, now that there is something better.
   *
   * Leaving it means the fallback above never empties, and a vault carries two
   * answers to the same question with nothing saying which is current.
   */
  await rm(join(vault.directory, LEGACY_FILE), { force: true });

  return body;
}
