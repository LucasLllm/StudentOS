import { z } from 'zod';
import type { LlmProvider } from '@contexto/llm';
import { SCHOOL_DOC } from '../prompts/documents.js';
import {
  SCHOOL_DOC_LIMIT,
  SCHOOL_DOC_NAME,
  capDocument,
  readDocument,
  writeDocument,
} from './documents.js';
import { renderNotes } from './render.js';
import { retrying } from './retry.js';
import type { Vault } from './vault.js';

/**
 * The one page in this vault written from outside the student's own account.
 *
 * Everything else here comes from their Classroom, their Drive and their inbox,
 * and between them those know a great deal about what this student does and
 * nearly nothing about the place they do it. A vault can name a teacher and
 * quote what they set, and cannot say when term ends, what the grades mean, or
 * what kind of school this is. None of that is in anybody's mailbox.
 *
 * So this pass researches, which nothing else in this product does. Three
 * calls: read the vault to work out what to ask, search the web to answer it,
 * then write the page from what came back. Only the middle one reaches the
 * network, because searches are billed one at a time and the other two have
 * nothing to look up.
 *
 * Written deliberately rather than on a schedule. A school's calendar does not
 * change between Tuesdays, and this is the most expensive thing here.
 */

export interface SchoolDocDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface SchoolDocOptions {
  vault: Vault;
  userId: string;
  /** The domains their school sends mail from. The one hard fact identifying it. */
  domains?: string[];
}

export interface SchoolDocResult {
  written: boolean;
  /** When the academic year ends, as `MM-DD`, where the research established one. */
  yearEnds: string | null;
}

/**
 * How much searching one research pass may do.
 *
 * Priced per search rather than per token, so this is the only cost in the
 * system that a model's own enthusiasm can run up. Twenty-five is a thorough
 * look at one school and a bill somebody would not notice.
 */
const SEARCHES = 25;

/** How much of the vault the first pass reads to work out what to ask. */
const SHOWN = 40;

/** Month and day, and nothing else. Anything looser is not a date. */
const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const research = z.object({
  school: z.string().nullish(),
  /** `MM-DD`, or absent. See the note on MONTH_DAY. */
  academicYearEnds: z.string().nullish(),
  findings: z
    .array(
      z.object({
        question: z.string(),
        answer: z.string(),
        sources: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const BRIEF = [
  'You are reading one student’s vault to work out what to research about their school.',
  '',
  'You are not answering anything yet, and you cannot look anything up. Write a short',
  'brief: what the evidence suggests the school is called, where it might be, what',
  'systems it runs, what its courses are named like, and anything else that would help',
  'somebody search for it. Then list the questions worth answering about the school',
  'itself -- its calendar, its curriculum, how it grades, what it is known for.',
  '',
  'Name the school only if the evidence names it. A mail domain is a strong hint and not',
  'an answer, and a school you think you recognise is the commonest way to research the',
  'wrong one entirely.',
].join('\n');

const RESEARCH = [
  'You are researching one school on the open web, from the brief below.',
  '',
  'Search for it. Read its own site above anything else -- the calendar, the academic',
  'programme, the admissions pages. Then answer the questions in the brief.',
  '',
  'The single most important answer is when the school’s academic year ENDS, because',
  'the rest of this system uses it to decide which of the student’s classes are still',
  'running.',
  '',
  'What is wanted is the time of year it ends, as MM-DD -- not a confirmed date for one',
  'particular year. Schools end their year within a week of the same date annually, so a',
  'published date from ANY recent year answers this: a calendar saying the 2025-26 year',
  'ended on the 19th of June gives you 06-19. So does a graduation date, a last-day-of',
  'classes, a report-card date, or a term-three end. Take the closest thing you found and',
  'say which year it came from.',
  '',
  'Report null only if you found nothing at all about when their year ends. A missing',
  'answer falls back to the 1st of July, which is later than every real school year and',
  'so keeps courses a few weeks longer than it should. That is the safe direction, but it',
  'is still worse than the right date -- do not decline merely because the coming year’s',
  'calendar is not published yet.',
  '',
  'Reply with JSON only, no prose around it:',
  '{"school": string | null, "academicYearEnds": string | null,',
  ' "findings": [{"question": string, "answer": string, "sources": string[]}]}',
  '',
  'Every finding carries the pages you actually read. A finding with no source is a',
  'thing you remembered rather than found, and does not belong here.',
].join('\n');

export async function writeSchoolDoc(
  { llm }: SchoolDocDeps,
  { vault, userId, domains }: SchoolDocOptions,
): Promise<SchoolDocResult> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  /*
   * What the vault can say about the school, which is mostly indirect.
   *
   * Courses and people, because a course name carries a year group and a
   * curriculum, and a staff address carries the domain. Recent mail, because a
   * signature block names the place more reliably than anything else here.
   */
  const evidence = [
    ...entities.filter((note) => note.description === 'Course' || note.description === 'Person'),
    ...episodes.slice(0, SHOWN),
  ].slice(0, SHOWN);

  const brief = await retrying(() =>
    llm.chat(
      {
        // Background work the student never waits on; medium is enough for a page
        // and a fifth of the reasoning bill.
        effort: 'medium',
        messages: [
          { role: 'system', content: BRIEF },
          {
            role: 'user',
            content: [
              domains?.length
                ? `Their school sends mail from: ${domains.join(', ')}.`
                : 'No school mail domain is known.',
              '',
              renderNotes(evidence),
            ].join('\n'),
          },
        ],
      },
      { userId },
    ),
  );

  const found = await retrying(() =>
    llm.chat(
      {
        effort: 'medium',
        messages: [
          { role: 'system', content: RESEARCH },
          {
            role: 'user',
            content: [
              domains?.length ? `The school sends mail from: ${domains.join(', ')}.` : '',
              '',
              'The brief:',
              typeof brief.content === 'string' ? brief.content : '',
            ].join('\n'),
          },
        ],
        // The only pass in this product that reaches the network.
        webSearch: { maxUses: SEARCHES },
      },
      { userId },
    ),
  );

  const answers = parse(found.content);

  const page = await retrying(() =>
    llm.chat(
      {
        effort: 'medium',
        messages: [
          { role: 'system', content: SCHOOL_DOC.body },
          {
            role: 'user',
            content: [
              answers?.school
                ? `The school is ${answers.school}.`
                : 'The school could not be named.',
              '',
              'What the research found:',
              ...(answers?.findings ?? []).map((finding) =>
                [
                  `- ${finding.question}`,
                  `  ${finding.answer}`,
                  ...finding.sources.map((source) => `  source: ${source}`),
                ].join('\n'),
              ),
              '',
              `The page may be at most ${SCHOOL_DOC_LIMIT} characters.`,
            ].join('\n'),
          },
        ],
      },
      { userId },
    ),
  );

  const body = capDocument(typeof page.content === 'string' ? page.content : '', SCHOOL_DOC_LIMIT);
  // A blank answer must not blank the page.
  if (body === '') return { written: false, yearEnds: await academicYearEnd(vault) };

  /*
   * Only a real month and a day.
   *
   * "late June" and "the third week of June" are what a model reaches for when
   * it has read a calendar rather than a date, and either would be compared as
   * a string against an ISO date and quietly lose.
   */
  const stated = answers?.academicYearEnds ?? null;
  const yearEnds = stated && MONTH_DAY.test(stated) ? stated : null;

  await writeDocument(vault, {
    name: SCHOOL_DOC_NAME,
    description: answers?.school ? `${answers.school}, researched` : 'Their school, researched',
    body,
    ...(yearEnds ? { yearEnds } : {}),
  });

  return { written: true, yearEnds };
}

/**
 * When the school's academic year ends, if anything has researched it.
 *
 * Read by the pass that decides which of a student's classes are current. Null
 * until a school page exists, which is why that pass has a fallback.
 */
export async function academicYearEnd(vault: Vault): Promise<string | null> {
  const document = await readDocument(vault, SCHOOL_DOC_NAME);
  return document?.yearEnds ?? null;
}

function parse(content: unknown): z.infer<typeof research> | null {
  if (typeof content !== 'string') return null;
  const text = content.trim().replace(/^```(?:json)?\s*/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = research.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
