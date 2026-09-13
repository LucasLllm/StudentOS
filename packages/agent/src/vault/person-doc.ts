import { createHash } from 'node:crypto';
import type { LlmProvider } from '@contexto/llm';
import { PERSON_DOC } from '../prompts/documents.js';
import {
  PERSON_DOC_LIMIT,
  PERSON_PREFIX,
  capDocument,
  listDocuments,
  personDocName,
  readDocument,
  writeDocument,
} from './documents.js';
import { renderNotes } from './render.js';
import { retrying } from './retry.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * A page per person, and the record that outlasts the course.
 *
 * When a class ends, everything in it goes: the room, the work, the files, the
 * mail about it. The teacher does not. They may teach this student again, and
 * in five years the only thing left of Grade 8 science may be that this person
 * taught it -- which is worth a page and is not worth a year of notifications
 * about homework that was due in March.
 *
 * So this is where a person survives being tidied up. Everything else about a
 * finished course is filtered out before it reaches the vault; the people are
 * distilled instead.
 */

export interface PersonDocDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface PersonDocOptions {
  vault: Vault;
  userId: string;
  /** The student's own note, where the vault has made one. Never given a page. */
  self?: string | null;
}

export interface PersonDocResult {
  written: number;
  /** Pages whose sources had not changed since they were last written. */
  skipped: number;
  /** Pages taken away, because the person is no longer in the vault. */
  removed: number;
}

/**
 * How much about one person to put in front of the writer.
 *
 * Most people in a vault appeared on one thread. The few who did not are
 * teachers, and a dozen things they wrote says what they are like far better
 * than a year of them.
 */
const SHOWN = 14;

/** And how much of it, in characters. Mail episodes run long. */
const BUDGET = 12_000;

export async function writePersonDocs(
  { llm }: PersonDocDeps,
  { vault, userId, self }: PersonDocOptions,
): Promise<PersonDocResult> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  /*
   * Everyone the vault knows, except the student.
   *
   * Their own note folds into the page about them, so a second page describing
   * them in the third person would be the same person written twice.
   */
  const people = entities.filter((note) => note.description === 'Person' && note.name !== self);

  const result: PersonDocResult = { written: 0, skipped: 0, removed: 0 };
  const wanted = new Set<string>();

  for (const person of people) {
    const name = personDocName(person.name);
    wanted.add(name);

    /*
     * What the vault has on them: what they wrote and what mentions them.
     *
     * Newest first, because what somebody is doing now says more about them
     * than the first thing they ever sent.
     */
    const link = `[[${person.name}]]`;
    const about = [...entities, ...episodes]
      .filter((note) => note.name !== person.name && note.body.includes(link))
      .sort((a, b) => (b.occurred ?? '').localeCompare(a.occurred ?? ''));

    const hash = fingerprint([person, ...about]);
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
            { role: 'system', content: PERSON_DOC.body },
            { role: 'user', content: brief(person, about) },
          ],
        },
        { userId },
      ),
    );

    const written = capDocument(
      typeof answer.content === 'string' ? answer.content : '',
      PERSON_DOC_LIMIT,
    );
    // A blank answer must not blank a page: an empty document and one that was
    // never written look the same from the outside.
    if (written === '') continue;

    await writeDocument(vault, {
      name,
      description: `${titleOf(person)}, as the vault has them`,
      body: written.includes(link) ? written : `${written}\n\nWritten from ${link}.`,
      sourceHash: hash,
    });
    result.written += 1;
  }

  /*
   * And take away the pages for people no longer in the vault.
   *
   * Not when there are none at all, though: that is an import that failed
   * rather than a student who knows nobody, and the two look identical here.
   */
  if (people.length === 0) return result;

  for (const document of await listDocuments(vault)) {
    if (!document.name.startsWith(PERSON_PREFIX) || wanted.has(document.name)) continue;
    if (await vault.remove('document', document.name)) result.removed += 1;
  }

  return result;
}

/** The name the importer wrote on the first line, up to the comma. */
function titleOf(note: VaultNote): string {
  return (note.body.split('\n')[0] ?? '').split(',')[0]?.trim() || note.name;
}

function fingerprint(notes: VaultNote[]): string {
  const parts = notes
    .map((note) => `${note.name}:${note.description}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

/** Everything the writer may work from, and nothing else. */
function brief(person: VaultNote, about: VaultNote[]): string {
  const shown: VaultNote[] = [];
  let spent = 0;

  for (const note of about.slice(0, SHOWN)) {
    const cost = note.body.length + note.description.length;
    if (shown.length > 0 && spent + cost > BUDGET) continue;
    shown.push(note);
    spent += cost;
  }

  return [
    `The page is about ${titleOf(person)}.`,
    `Their note is [[${person.name}]].`,
    shown.length === 0
      ? 'Nothing in the vault mentions them beyond the note itself. Say their name and what' +
        ' little is known, and stop.'
      : 'What the vault has about them, newest first:',
    '',
    /*
     * Through the same renderer as everything else.
     *
     * This is a teacher's own writing, and being on the way to a page rather
     * than to a reply does not make it safe -- least of all here, where the
     * output is later labelled as ours.
     */
    renderNotes([person, ...shown]),
  ].join('\n');
}
