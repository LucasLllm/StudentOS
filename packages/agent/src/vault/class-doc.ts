import { createHash } from 'node:crypto';
import type { LlmProvider } from '@contexto/llm';
import { CLASS_DOC } from '../prompts/documents.js';
import {
  CLASS_DOC_LIMIT,
  capDocument,
  classDocName,
  listDocuments,
  readDocument,
  writeDocument,
} from './documents.js';
import { buildGraph } from './graph.js';
import { renderNotes } from './render.js';
import { retrying } from './retry.js';
import type { CourseVerdict } from './courses.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * A page per class, written from the notes filed under it.
 *
 * The layer that makes a vault answerable. Four thousand notes will not fit in
 * a prompt and nobody would read them if they did; one page per subject can be
 * opened when a question turns out to be about that subject, and says what
 * taking it is actually like.
 *
 * One page per SUBJECT, not per Classroom room. This student has two French
 * teachers in two rooms and one French class, and a vault that answers "which
 * French?" has failed at the only question it was asked.
 *
 * The notes stay. This page summarises them; it does not replace them. An
 * assignment, a file, a project is still its own note and still reachable
 * through search -- what this adds is a way in that does not require knowing
 * what to search for.
 */

export interface ClassDocDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface ClassDocOptions {
  vault: Vault;
  /** What the filter decided: which courses survive, and which subject each is. */
  verdicts: CourseVerdict[];
  userId: string;
}

export interface ClassDocResult {
  written: number;
  /** Pages whose sources had not changed since they were last written. */
  skipped: number;
  /** Pages taken away, because the student no longer takes that subject. */
  removed: number;
}

/**
 * How much of a course to put in front of the writer.
 *
 * A year of a busy subject is more than a page needs and more than a prompt
 * should carry. What a course *is* shows in its units and a sample of what it
 * asks for; the rest is detail the page is not allowed to mention anyway,
 * because it expires.
 */
const SHOWN = 60;

/**
 * And how much of it, in characters.
 *
 * The count alone is not a bound. Mail episodes on a real account run to
 * thirteen thousand characters each, so sixty notes can be a six-figure prompt
 * -- per class, nine times a build, every six hours. This is roughly six
 * thousand tokens of reading, which is enough to say what a subject is.
 */
const BUDGET = 24_000;

export async function writeClassDocs(
  { llm }: ClassDocDeps,
  { vault, verdicts, userId }: ClassDocOptions,
): Promise<ClassDocResult> {
  const kept = verdicts.filter((verdict) => verdict.keep);

  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);
  const courses = entities.filter((note) => note.description === 'Course');

  /**
   * The course notes a verdict is about, matched on the title the importer wrote.
   *
   * All of them, not the first. A school can give two rooms of one subject the
   * same name -- the importer already copes, naming the second `french-2` --
   * and matching on the title alone would find one of the two and quietly leave
   * everything filed under the other out of the page describing the subject.
   */
  const notesFor = (courseName: string): VaultNote[] =>
    courses.filter((note) => titleOf(note) === courseName);

  /** subject -> the course notes it merges. */
  const subjects = new Map<string, { notes: VaultNote[]; academic: boolean }>();
  for (const verdict of kept) {
    // A course the classifier never answered for has no subject to file it
    // under, and guessing one is what wrote a page named after a raw course
    // title. It waits for a build that gets an answer.
    if (verdict.subject === null) continue;

    const found = notesFor(verdict.course);
    if (found.length === 0) continue;

    const already = subjects.get(verdict.subject);
    if (already) {
      // Two verdicts naming one room must not put it in the group twice.
      const seen = new Set(already.notes.map((note) => note.name));
      already.notes.push(...found.filter((note) => !seen.has(note.name)));
    } else {
      subjects.set(verdict.subject, { notes: found, academic: verdict.academic });
    }
  }

  const { nodes } = await buildGraph(vault);
  const byName = new Map([...entities, ...episodes].map((note) => [note.name, note]));

  const result: ClassDocResult = { written: 0, skipped: 0, removed: 0 };
  const wanted = new Set<string>();

  for (const [subject, { notes, academic }] of subjects) {
    const name = classDocName(subject);
    wanted.add(name);

    const homes = new Set(notes.map((note) => note.name));
    const cluster = nodes
      .filter((node) => node.cluster && homes.has(node.cluster))
      .map((node) => byName.get(node.name))
      .filter((note): note is VaultNote => note !== undefined);

    /*
     * A fingerprint of everything the page is written from.
     *
     * Names and descriptions rather than whole bodies: a body changes when a
     * file is re-read and says the same thing, and rewriting the page for that
     * is what this exists to avoid.
     *
     * The verdict is part of it, because the verdict is half of what the page
     * says. When a room called French 11 stopped being read as a taught
     * subject, none of its notes had changed -- so a hash over the notes alone
     * skipped the page, and it went on calling itself a subject and being
     * listed among the student's subjects, with the classifier already
     * disagreeing.
     */
    const hash = fingerprint([...notes, ...cluster], academic);
    const existing = await readDocument(vault, name);
    if (existing?.sourceHash === hash) {
      result.skipped += 1;
      continue;
    }

    const answer = await retrying(() =>
      llm.chat(
        {
          // Background work the student never waits on; medium is enough for a page
          // and a fifth of the reasoning bill.
          effort: 'medium',
          messages: [
            { role: 'system', content: CLASS_DOC.body },
            { role: 'user', content: brief(subject, academic, notes, cluster) },
          ],
        },
        { userId },
      ),
    );

    const written = capDocument(
      typeof answer.content === 'string' ? answer.content : '',
      CLASS_DOC_LIMIT,
    );
    const body = written === '' ? '' : withRooms(written, notes);
    /*
     * A blank answer must not blank a page.
     *
     * An empty document and one that was never written look the same from the
     * outside, and the agent would carry on with nothing to say about a subject
     * with no sign of why.
     */
    if (body === '') continue;

    await writeDocument(vault, {
      name,
      description: academic
        ? `${subject}, as the vault has it`
        : `${subject} -- not a subject they take, but something they do`,
      body,
      academic,
      sourceHash: hash,
    });
    result.written += 1;
  }

  /*
   * And take away the pages for subjects that are no longer theirs.
   *
   * A class document outlives the course it describes unless something removes
   * it, and a page about last year's history is exactly what this whole change
   * exists to get out of the vault.
   *
   * Not when there were no verdicts at all, though. That is Classroom being
   * briefly unreachable, not a student dropping every subject they take, and
   * the two look identical from here -- so the one that deletes nothing wins.
   *
   * Nor when nothing was judged. A build where the classifier answered for no
   * course at all leaves every verdict without a subject, and clearing the
   * pages on that would empty a student's vault because one call failed.
   *
   * Judged and dropped is a different thing entirely, and still removes: that
   * is a student who has finished a subject, which is the case this exists for.
   */
  if (verdicts.length === 0) return result;
  if (verdicts.every((verdict) => verdict.subject === null)) return result;

  for (const document of await listDocuments(vault)) {
    if (!document.name.startsWith('class-') || wanted.has(document.name)) continue;
    if (await vault.remove('document', document.name)) result.removed += 1;
  }

  return result;
}

/**
 * The rooms this page was written from, linked at the end of it.
 *
 * Written by code rather than asked for in the prompt, because asked-for is how
 * it went missing: eight of nine pages on a real account had no link back to
 * the Classroom room they describe, and the ninth did. That is what a model
 * choosing looks like, and this link is not the kind of thing that should be
 * chosen -- it is the only edge joining a page to the evidence underneath it.
 *
 * Appended after the budget is applied, so it cannot be the thing that gets cut.
 */
function withRooms(body: string, courses: VaultNote[]): string {
  const missing = courses.filter((note) => !body.includes(`[[${note.name}]]`));
  if (missing.length === 0) return body;

  const rooms = missing.map((note) => `[[${note.name}]]`).join(' and ');
  return `${body}\n\nWritten from ${rooms}.`;
}

/**
 * The name the importer wrote on the first line.
 *
 * Recovered by removing the suffix it appends, not by splitting on the first
 * comma: a course really can be called "Le parlement des jeunes, 8-10 avril
 * 2026", and splitting lost everything after "jeunes". Every course without a
 * comma matched, which is why it took counting pages against courses to see.
 */
function titleOf(note: VaultNote): string {
  const first = note.body.split('\n')[0] ?? '';
  return first.replace(/,\s*on Google Classroom\.?\s*$/i, '').trim();
}

function fingerprint(notes: VaultNote[], academic: boolean): string {
  const parts = [
    `academic:${academic}`,
    ...notes.map((note) => `${note.name}:${note.description}`).sort(),
  ].join('\n');
  return createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

/** Everything the writer is allowed to work from, and nothing else. */
function brief(
  subject: string,
  academic: boolean,
  courses: VaultNote[],
  cluster: VaultNote[],
): string {
  const of = (description: string) => cluster.filter((note) => note.description === description);

  const people = of('Person');

  return [
    `The subject is ${subject}.`,
    academic
      ? 'It is a taught subject.'
      : 'It is not a taught subject: it is a club, team or group they belong to. Describe it as that.',
    courses.length > 1
      ? `It is taught in ${courses.length} Classroom rooms, which are one class to this student. Write one page covering all of them.`
      : '',
    '',
    'Names you may link to, and no others:',
    ...[...courses, ...cluster].slice(0, SHOWN * 2).map((note) => `- ${note.name}`),
    '',
    people.length > 0
      ? 'The people who appear in this subject. Only one of these can be its teacher:'
      : 'Nobody is recorded against this subject. Say the teacher is not recorded.',
    ...people.map((note) => `- [[${note.name}]] ${note.description}`),
    '',
    'The course, and what is filed under it:',
    '',
    /*
     * Through the same renderer as everything else.
     *
     * These notes are a teacher's words. Nothing about being on the way to a
     * document rather than to a reply makes them safe, and this is the pass
     * whose output is later labelled as ours.
     */
    renderNotes(withinBudget([...courses, ...cluster])),
  ].join('\n');
}

/**
 * As many notes as fit, courses first.
 *
 * Whole notes rather than a truncated string: half a note reads as a complete
 * one that happens to stop, which is worse than an absent one. The course notes
 * are prepended by the caller and so are never the ones dropped -- whatever
 * else is cut, the thing the page is about survives the cut.
 */
function withinBudget(notes: VaultNote[]): VaultNote[] {
  const kept: VaultNote[] = [];
  let spent = 0;

  for (const note of notes.slice(0, SHOWN)) {
    const cost = note.body.length + note.description.length;
    if (kept.length > 0 && spent + cost > BUDGET) continue;
    kept.push(note);
    spent += cost;
  }

  return kept;
}
