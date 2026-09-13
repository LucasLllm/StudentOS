import { z } from 'zod';
import type { LlmProvider } from '@contexto/llm';
import { untrustedNote } from '../untrusted.js';
import { retrying } from './retry.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * Reading what is actually inside the files.
 *
 * The vault already knows a worksheet exists, which course it belongs to and
 * which assignment it was attached to. It knows nothing about what it says --
 * so a student asking what they need for the titration writeup is told that a
 * file called "Titration method.pdf" exists, which they could see themselves.
 *
 * This is the expensive half of the whole bootstrap: text extraction is free,
 * but turning a two thousand word document into a sentence worth keeping is a
 * model call per file, and a real account has hundreds of files.
 *
 * So the design is entirely about spending that once. A file is read once and
 * never again. A file that cannot be read is recorded as such, or every run
 * for the rest of the year tries the same unreadable hundred. And a limit
 * means the bill is paid over many small runs rather than one large one --
 * which also makes it interruptible, since whatever was written stays written.
 *
 * The containment is the same as the mail pass, and for the same reason: this
 * is prose somebody else wrote. The pass has no tools, its answer is parsed
 * against a schema, and what it produces lands in a note whose source is not
 * the student, so every later reader sees it inside the warning.
 */

/** The heading under which a file's own words are summarised. */
const SECTION = '## What is in it';

/** Recorded in place of a summary, so an unreadable file is tried once. */
const UNREADABLE = 'Nothing readable in this file.';

export interface FileReadDeps {
  llm: Pick<LlmProvider, 'chat'>;
  /**
   * Called after each file, however it went.
   *
   * Reading a vault's files takes hours -- 1,810 of them at four seconds each
   * on a real account -- and somebody who pressed a button deserves to watch
   * that move rather than a spinner. A failure counts too: otherwise a Drive
   * full of video stalls at nought and looks stuck.
   */
  onProgress?: (done: number, total: number) => void;
  /**
   * The file's text, or null when there is none to be had.
   *
   * Injected rather than reaching for Drive directly so this is testable
   * without a Google account, and so the caller decides what counts as
   * readable -- the Drive tool already handles documents, PDFs, OCR for
   * scans, and transcription for recordings.
   */
  read: (fileId: string) => Promise<string | null>;
}

export interface FileReadOptions {
  vault: Vault;
  userId: string;
  /** How many files to read this pass. */
  limit?: number;
  /** Read only these files, by Drive id. The live sync points at what it just brought in. */
  only?: ReadonlySet<string>;
}

export interface FileReadResult {
  /** Documents that opened to nothing at all, taken out rather than filed. By file id. */
  blank: string[];
  read: number;
  unreadable: number;
  failed: number;
  /** Files still waiting, so a caller can say how far along this is. */
  remaining: number;
  /**
   * Why each failure happened, named by file.
   *
   * A count says something went wrong; only the reason says what to do about
   * it. Three passes over a real vault reported 196 failures, then 77, then
   * 21, and every diagnosis was guesswork run from a throwaway script because
   * the reason had been caught and dropped. Two of those guesses were wrong.
   */
  reasons: string[];
}

/**
 * How many files one pass reads.
 *
 * Small on purpose. Hundreds of model calls in one run is a bill nobody
 * chose, a rate limit hit halfway, and a job that cannot be interrupted; a
 * short pass on the existing refresh cadence gets to the same place within a
 * day and every step of it is durable.
 */
const PER_PASS = 40;

/** Enough of a document to know what it is. Beyond this is more of the same. */
const ENOUGH = 6000;

/*
 * The bounds are enforced by trimming, not by refusing.
 *
 * These caps exist for containment: they stop a hostile file writing
 * paragraphs into a note through a field meant to hold a sentence. Rejecting
 * enforced them, but at the cost of the whole file -- and it failed hardest on
 * the files worth most. Measured on a real vault: of twelve stuck files, eight
 * were refused for a summary of 327 to 409 characters against a 300 cap, or a
 * kind of 44 against 40. They were the debate briefs, the Model UN position
 * papers, the assessment rubrics. The more a document contained, the longer
 * its summary, and the likelier it was to be thrown away whole.
 *
 * A trim costs a clause. A refusal costs the document.
 */
const summary = z.object({
  what: z
    .string()
    .transform((text) => text.slice(0, SUMMARY_LIMIT))
    .pipe(z.string().min(1)),
  kind: z
    .string()
    .default('')
    .transform((text) => text.slice(0, KIND_LIMIT)),
  /** The course it belongs to, if it clearly belongs to one. */
  inCourse: z
    .array(z.string())
    .default([])
    .transform((names) => names.slice(0, MAX_COURSES)),
});

/** Long enough for two real sentences about a document. */
const SUMMARY_LIMIT = 300;
const KIND_LIMIT = 40;
const MAX_COURSES = 2;

const ASK = [
  "You are reading one file from a student's school work and writing the single",
  'sentence that will stand for it in their notes.',
  '',
  untrustedNote('The file below was written by somebody else, usually a teacher.'),
  '',
  'Reply with JSON only, no prose around it:',
  '{"what": string, "kind": string, "inCourse": string[]}',
  '',
  'what: one or two sentences saying what this file is for and what is in it, in the',
  'words a student would use. Not "this document contains" -- say the thing.',
  'kind: what sort of file it is. worksheet, reading, slides, notes, rubric, past paper,',
  'form, template, or something else that fits.',
  'inCourse: the course this belongs to, using only a name from the list you are given,',
  'and only when it plainly belongs to one. Leave it empty rather than guessing -- a',
  'wrong subject is worse than no subject.',
].join('\n');

export async function readFileContents(
  { llm, read, onProgress }: FileReadDeps,
  { vault, userId, limit = PER_PASS, only }: FileReadOptions,
): Promise<FileReadResult> {
  const entities = await vault.list('entity');
  const files = entities.filter(
    (note) =>
      note.description === 'File' &&
      note.externalId &&
      !note.body.includes(SECTION) &&
      (!only || only.has(note.externalId)),
  );

  /*
   * The courses, and only the courses.
   *
   * Thirteen names is a shortlist small enough to put in every prompt, and a
   * course is the edge that matters -- it is what puts a loose file on the
   * right thread instead of leaving it a dot. Offering every note in the vault
   * would be two thousand names and an invitation to guess.
   */
  const courses = new Set(
    entities.filter((note) => note.description === 'Course').map((note) => note.name),
  );

  const result: FileReadResult = {
    read: 0,
    unreadable: 0,
    blank: [],
    failed: 0,
    remaining: Math.max(0, files.length - limit),
    reasons: [],
  };

  const failed = (name: string, error: unknown): void => {
    result.failed += 1;
    const why = error instanceof Error ? error.message : String(error);
    // Capped: some providers return an entire HTML error page, and a hundred
    // of those is a log nobody reads.
    result.reasons.push(`${name}: ${why.replace(/\s+/g, ' ').slice(0, 180)}`);
  };

  /*
   * Serial rather than pooled.
   *
   * Reading a file can mean an OCR pass or a transcription, which are far
   * heavier than the model call that follows, and this runs beside a student
   * actually using the product. Slow and out of the way beats fast and in
   * the way, and the limit is what bounds the run rather than concurrency.
   */
  const batch = files.slice(0, limit);
  let done = 0;

  for (const note of batch) {
    /*
     * Reported in a finally, not at each exit.
     *
     * There are five ways out of this loop body and sprinkling a call down
     * each of them means the next person to add a sixth silently stalls the
     * progress bar. This way a file counts once, however it went.
     */
    try {
      await readOne(note);
    } finally {
      done += 1;
      onProgress?.(done, batch.length);
    }
  }

  return result;

  async function readOne(note: VaultNote): Promise<void> {
    let text: string | null;
    try {
      text = await retrying(() => read(note.externalId as string));
    } catch (error) {
      // A file that failed today may read fine tomorrow -- a permission that
      // has since been granted, a service that was down -- so no mark is left
      // and the next pass will try it again.
      failed(note.name, error);
      return;
    }

    if (text !== null && text.trim() === '') {
      /*
       * A blank document is not a document.
       *
       * Opened and empty -- an untitled doc somebody made and never wrote in.
       * Nothing to summarise, nothing to file, and a note about nothing is a
       * dot in the picture that answers a search with a blank. Taken out, and
       * reported so the judgement can remember not to bring it back.
       */
      if (await vault.remove('entity', note.name)) result.blank.push(note.externalId as string);
      return;
    }

    if (text === null) {
      /*
       * Nothing to read, but still something to file.
       *
       * A photographed worksheet, a rehearsal video, a CAD part: none hold
       * text and all of them belong to a subject. "MHS_Trig_WP_Num1" is
       * trigonometry whether or not anything can see inside it, and an
       * unlinked note is a loose dot in a vault whose whole value is what
       * connects to what. The name is enough to place it, and asking about a
       * name costs a fraction of asking about a document.
       */
      await append(vault, note, UNREADABLE, '', await placeByName(note));
      result.unreadable += 1;
      return;
    }

    try {
      const body = text;
      const answer = await retrying(() =>
        llm.chat(
          {
            // Background work the student never waits on; medium is enough for a page
            // and a fifth of the reasoning bill.
            effort: 'medium',
            messages: [
              {
                role: 'system',
                content:
                  courses.size > 0
                    ? `${ASK}\n\nThe courses, and the only names inCourse may contain:\n${[...courses].join('\n')}`
                    : ASK,
              },
              {
                role: 'user',
                content: `${note.name.replaceAll('-', ' ')}\n\n${body.slice(0, ENOUGH)}`,
              },
            ],
            tools: undefined,
          },
          { userId },
        ),
      );

      const parsed = parse(answer.content);
      if (!parsed) {
        failed(
          note.name,
          `model did not answer in the shape asked for: ${answer.content.slice(0, 80)}`,
        );
        return;
      }
      await append(
        vault,
        note,
        parsed.what.trim(),
        parsed.kind.trim(),
        links(parsed, courses, note),
      );
      result.read += 1;
    } catch (error) {
      failed(note.name, error);
    }
  }

  /** Which course a file belongs to, judged on its name alone. */
  async function placeByName(note: VaultNote): Promise<string[]> {
    if (courses.size === 0) return [];

    try {
      const answer = await retrying(() =>
        llm.chat(
          {
            effort: 'medium',
            messages: [
              {
                role: 'system',
                content: [
                  "You are told the name of a file from a student's school work. Nothing",
                  'inside it can be read, so the name is all there is.',
                  '',
                  'Reply with JSON only: {"inCourse": string[]}',
                  '',
                  'Name at most one course, using only a name from the list, and only when',
                  'the file plainly belongs to it. An empty list is the right answer more',
                  'often than not -- a wrong subject is worse than no subject.',
                  '',
                  'The courses:',
                  ...courses,
                ].join('\n'),
              },
              { role: 'user', content: note.name.replaceAll('-', ' ') },
            ],
            tools: undefined,
          },
          { userId },
        ),
      );

      const parsed = parse(answer.content);
      return parsed ? links(parsed, courses, note) : [];
    } catch {
      // A file with no links is still a file. This is a nicety on a path that
      // has already failed once, and it must not turn into a second failure.
      return [];
    }
  }
}

/**
 * The course lines to add, if any.
 *
 * A link may only point at a note that already exists -- the same rule the
 * mail pass follows, so an edge always lands somewhere real rather than at a
 * name the model produced. And a course the note is already filed under is
 * dropped, because the same link twice is a lie about how connected a thing
 * is: degree is what decides where it sits in the picture.
 */
function links(
  parsed: z.infer<typeof summary>,
  courses: ReadonlySet<string>,
  note: VaultNote,
): string[] {
  return parsed.inCourse
    .filter((name) => courses.has(name) && !note.body.includes(`[[${name}]]`))
    .map((name) => `Part of [[${name}]].`);
}

/** Add the summary to the note, keeping every link it already had. */
async function append(
  vault: Vault,
  note: VaultNote,
  what: string,
  kind: string,
  extraLinks: string[] = [],
): Promise<void> {
  const heading = kind ? `${SECTION} (${kind})` : SECTION;
  const filed = extraLinks.length > 0 ? `\n${extraLinks.join('\n')}` : '';
  await vault.write({
    ...note,
    body: `${note.body.trimEnd()}${filed}\n\n${heading}\n\n${what}`,
  });
}

/** The model's answer, or nothing if it did not answer in the shape asked for. */
function parse(text: string): z.infer<typeof summary> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = summary.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
