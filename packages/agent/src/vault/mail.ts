import { z } from 'zod';
import type { ChatMessage, LlmProvider } from '@contexto/llm';
import { VAULT_WRITING } from '../prompts/documents.js';
import { untrustedNote } from '../untrusted.js';
import { retrying } from './retry.js';
import { slugForNote } from './slug.js';
import type { EpisodeEvent, Vault } from './vault.js';

/**
 * Turning school mail into ContextoVault episodes.
 *
 * The only part of the bootstrap that needs a model. Classroom arrives as
 * objects with ids; mail arrives as prose somebody else wrote, and deciding
 * what a message means is judgement rather than mapping.
 *
 * What an episode is, and when one is worth making, is defined once in
 * prompts/vault-writing.md rather than restated here. That document is the
 * system prompt for this pass and for every other pass that writes into the
 * vault, so the rules cannot drift between them.
 *
 * The containment is structural rather than a matter of asking nicely:
 *
 *   The pass runs with no tools. A hijacked model has nothing to call, so the
 *   worst outcome available to a hostile message is a wrong sentence in a
 *   note -- visible in the memory panel and deletable by the student.
 *
 *   Its answer is parsed against a schema. Free text is confined to one
 *   summary field with a length cap, so instructions cannot ride out through a
 *   shape that was meant to carry a name.
 *
 *   Links may only point at notes that already exist. It cannot invent a
 *   target, so an edge always lands somewhere real.
 */

export interface SchoolMessage {
  messageId: string;
  from: string;
  /**
   * Who it was sent to, and who was copied.
   *
   * Gmail returns both and the collector dropped them, so a note written
   * personally to one student and a circular sent to nine hundred people
   * arrived here identical. That difference is the best relevance signal a
   * school inbox has: "your essay is late" and "Grade 11 graduation dinner"
   * are told apart by the recipient list before a word of either is read.
   */
  to?: string;
  cc?: string;
  subject: string;
  date: string;
  body: string;
}

export interface MailImportDeps {
  llm: Pick<LlmProvider, 'chat'>;
  /**
   * Called as each message is extracted.
   *
   * The second longest phase of a build -- 668 messages at three seconds each,
   * six at a time -- and the one where a student is most likely to think
   * nothing is happening.
   */
  onProgress?: (done: number, total: number) => void;
}

export interface MailImportOptions {
  vault: Vault;
  messages: SchoolMessage[];
  /** Note names an episode may link to. Nothing else is accepted. */
  entities: string[];
  userId: string;
  /** The school's domains. A sender outside them is not one of their teachers. */
  domains?: string[];
  /**
   * Courses the vault has decided not to hold, by their Classroom name.
   *
   * Recovery below writes a course note for any class a notification names, and
   * a year of last year's mail is still in range after that course has been
   * filtered out -- so without this the filter drops it and the next import
   * writes it back, every build, for as long as the mail lasts.
   */
  dropped?: string[];
  /**
   * The start of the current academic year, as an ISO date.
   *
   * The other half of the guard above, and the half `dropped` cannot cover. A
   * course DELETED from Classroom never appears in a snapshot, so the filter
   * forms no verdict on it and never names it -- while its mail stays in range
   * for a year. Recovering one would make a course note that nothing can ever
   * evaluate and therefore nothing can ever remove.
   */
  since?: string;
}

export interface MailImportResult {
  written: number;
  skipped: number;
  people: number;
}

const EVENTS = [
  'assignment-posted',
  'assignment-graded',
  'deadline-changed',
  'announcement',
  'material-posted',
  'message',
  'conversation',
  'other',
] as const;

const extraction = z.object({
  keep: z.boolean(),
  what: z.string().max(400),
  /** Who did it, as a student would say it. Empty when it was a system. */
  actor: z.string().max(80).default(''),
  event: z.enum(EVENTS).default('other'),
  /** The specific thing: an assignment, a topic. */
  about: z.array(z.string()).max(5).default([]),
  /** The course it belongs to. */
  inCourse: z.array(z.string()).max(3).default([]),
});

const ASK = [
  'You are reading one email from a school inbox and writing a single episode for',
  'ContextoVault, following the rules above.',
  '',
  untrustedNote('The message below was written by whoever sent it, not by the student.'),
  '',
  'Reply with JSON only, no prose around it:',
  '{"keep": boolean, "what": string, "actor": string, "event": string,',
  ' "about": string[], "inCourse": string[]}',
  '',
  `event is one of: ${EVENTS.join(', ')}.`,
  '',
  'about and inCourse may only contain names from the list you are given. Omit rather',
  'than guess, and link the specific thing as well as the course it belongs to.',
  '',
  'Before setting keep, ask: would this student have to do or know anything different',
  'because of this message? A bulletin about the choir, the canteen and the car park',
  'changes nothing for them, so keep is false. Most mail is false.',
].join('\n');

/**
 * Senders that are software rather than people.
 *
 * A note for no-reply@classroom.google.com would become one of the most-linked
 * nodes in the vault, and it is not somebody the student knows.
 */
const AUTOMATED =
  /(^|[.@])(no-?reply|noreply|do-?not-?reply|notifications?|mailer|bounce)([.@]|$)/i;

/** `"Mrs. Bell" <bell.j@school.example>` into its two halves. */
/**
 * Classroom's own notification address.
 *
 * Every teacher in the school writes from it, which makes the address useless
 * for identity and the display name -- "Stacey Ottley (Classroom)" -- the only
 * thing that matters. That is the reverse of every other message in an inbox,
 * where the name varies and the address is the constant.
 */
const CLASSROOM_NOTIFICATIONS = 'no-reply@classroom.google.com';

/**
 * What a Classroom notification says its sender did.
 *
 * Only some of these are things a teacher can do. Posting an assignment, an
 * announcement, a material or a question, grading work, inviting somebody to a
 * class: all of those require teaching the class. Leaving a comment does not,
 * and Classroom notifies on a classmate's comment with a sender line identical
 * to a teacher's -- "Brady Snyder (Classroom)".
 *
 * Reading every one of them as somebody at the school rebuilds the exact
 * mistake the mail-domain rule exists to prevent: a classmate who appears
 * beside one subject and is taken to teach it. The subject line is what
 * separates them, and it is the only thing that does.
 */
const TEACHER_ACTIONS =
  /^(?:re:\s*)?(?:new (?:assignment|announcement|material|question)|graded|class invitation)\b/i;

/**
 * The teacher's name out of "Stacey Ottley (Classroom)", or null.
 *
 * Null for anything a student could have sent, and for the automated
 * reminders, which are about somebody's assignment rather than by them.
 */
/**
 * What Classroom says happened, from the subject line.
 *
 * Classroom is stating a fact about what somebody did, and it is a better
 * source for that than a pass summarising the message afterwards -- which sees
 * a third-person notification and reasonably calls it a message. The event is
 * what later tells a reader that this is a record of somebody teaching rather
 * than somebody being mentioned.
 */
export function classroomEvent(subject: string): EpisodeEvent | null {
  const head = subject.trim().replace(/^re:\s*/i, '');
  if (/^new assignment\b/i.test(head)) return 'assignment-posted';
  if (/^new (?:announcement|question)\b/i.test(head)) return 'announcement';
  if (/^new material\b/i.test(head)) return 'material-posted';
  if (/^graded\b/i.test(head)) return 'assignment-graded';
  return null;
}

/**
 * The course a Classroom notification is about.
 *
 * Every one of them names its course in the body, on its own line, directly
 * above a link to that course. It is the only way to learn about a class the
 * API will not return -- one the school deleted, or archived beyond the states
 * this app can ask for -- and those classes had been vanishing in silence: the
 * mail could only link to courses that already had a note, so the reference
 * was dropped with nothing left dangling to show it had gone.
 */
export function classroomCourse(body: string): string | null {
  const lines = body.split('\n');
  const at = lines.findIndex((line) => /classroom\.google\.com\/c\//.test(line));
  if (at < 1) return null;

  // The nearest line above the link that is text rather than another link.
  for (let i = at - 1; i >= 0 && at - i <= 3; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('<') || /https?:\/\//.test(line)) continue;
    return line;
  }
  return null;
}

/**
 * Whether a message is Classroom writing about one of these courses.
 *
 * Every Classroom notification names its course on its own line above the link
 * to it, followed by whatever else the school appends -- a section, a teacher.
 * So the test is whether that line begins with a course we no longer hold,
 * which uses the school's own name for it rather than guessing from prose.
 *
 * Mail about a dropped class is the last place last year survives. Its course
 * is gone, its assignments are gone, and the mail stays precisely because the
 * course was removed thoroughly enough that nothing is left to sweep it with.
 */
export function namesCourse(body: string, courses: readonly string[]): boolean {
  if (courses.length === 0) return false;

  const line = classroomCourse(body);
  if (!line) return false;

  const said = line.toLowerCase();
  return courses.some((course) => said.startsWith(course.toLowerCase()));
}

/** The event prefix Classroom puts on a subject, so the rest is the thing itself. */
const EVENT_PREFIX =
  /^(?:re:\s*)?(?:new (?:assignment|announcement|material|question)|graded)\s*[:\-–—]?\s*/i;

/**
 * What a Classroom notification says, read off the notification.
 *
 * Every one of these used to cost a model call, although the announcement or
 * assignment it announces arrives structurally through the Classroom import
 * for nothing. The subject states the event, the body names the course, the
 * sender names the teacher, and all three parsers already exist. So these
 * episodes are written from those, and the model is kept for mail a person
 * wrote. Reminders and comments keep nothing, which is what the model decided
 * for them anyway.
 *
 * Null for anything not from Classroom's own address.
 */
export function classroomEpisode(message: SchoolMessage): z.infer<typeof extraction> | null {
  const { address } = parseSender(message.from);
  if (address !== CLASSROOM_NOTIFICATIONS) return null;

  const event = classroomEvent(message.subject);
  if (!event) return { keep: false, what: '', actor: '', event: 'other', about: [], inCourse: [] };

  const remainder = message.subject.trim().replace(EVENT_PREFIX, '').trim();
  const course = classroomCourse(message.body);
  let paragraph =
    message.body
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find(
        (part) =>
          part !== '' &&
          !/https?:\/\//.test(part) &&
          part !== course &&
          part.toLowerCase() !== remainder.toLowerCase() &&
          !/^hi\b|^hello\b/i.test(part) &&
          !/posted a new|graded your/i.test(part),
      ) ?? '';

  // Strip the leading line if it equals the remainder, so the title isn't repeated.
  if (paragraph) {
    const lines = paragraph.split('\n');
    if (lines[0]?.toLowerCase() === remainder.toLowerCase()) {
      paragraph = lines.slice(1).join('\n').trim();
    }
  }

  const what = [remainder, paragraph].filter(Boolean).join('. ').slice(0, 300) || message.subject;

  return {
    keep: true,
    what,
    actor: classroomSender(message.from, message.subject) ?? '',
    event: event as (typeof EVENTS)[number],
    about: remainder ? [slugForNote(remainder)] : [],
    inCourse: course ? [slugForNote(course)] : [],
  };
}

export function classroomSender(from: string, subject = ''): string | null {
  const { display, address } = parseSender(from);
  if (address !== CLASSROOM_NOTIFICATIONS) return null;
  if (!TEACHER_ACTIONS.test(subject.trim())) return null;
  const named = display.replace(/\s*\(Classroom\)\s*$/i, '').trim();
  return named === '' || named === address ? null : named;
}

function parseSender(from: string): { display: string; address: string } {
  const angled = /<([^>]+)>/.exec(from);
  const address = (angled?.[1] ?? from).trim().toLowerCase();
  const display = from
    .replace(/<[^>]*>/, '')
    .replace(/["']/g, '')
    .trim();
  return { display: display || address, address };
}

export async function importMail(
  { llm, onProgress }: MailImportDeps,
  { vault, messages, entities, userId, domains, dropped, since }: MailImportOptions,
): Promise<MailImportResult> {
  const existingEpisodes = await vault.list('episode');
  const already = new Set(existingEpisodes.map((note) => note.externalId).filter(Boolean));
  const takenNames = new Set(existingEpisodes.map((note) => note.name));

  const allowed = new Set(entities);

  /** Courses the filter has already refused, so recovery does not undo it. */
  const refused = new Set(dropped ?? []);
  const refusedTitles = dropped ?? [];

  /** Courses already noted, so mail only creates the ones nobody has. */
  const knownCourses = new Set(
    (await vault.list('entity'))
      .filter((note) => note.description === 'Course')
      .map((note) => note.name),
  );
  for (const slug of knownCourses) allowed.add(slug);
  const neighbours = neighbourMap(await vault.list('entity'));

  /*
   * People are resolved by address, never by name.
   *
   * The first real run produced lucas-liu and lucas-yunqi-liu: one person,
   * twice, because the note was named after the model's rendering of the name
   * and that varies between messages. An address does not vary. This is the
   * entity resolution failure the design exists to avoid, and it appeared the
   * moment real mail arrived -- exactly as the literature says it does.
   */
  const peopleByAddress = new Map(
    (await vault.list('entity'))
      .filter((note) => note.description === 'Person' && note.externalId)
      .map((note) => [note.externalId as string, note.name]),
  );

  /*
   * The same people, keyed by slug.
   *
   * A teacher can arrive twice: once from their own address and once from a
   * Classroom notification that knows their name and not their address. The
   * name is the only thing those two share.
   */
  const peopleBySlug = new Map(
    (await vault.list('entity'))
      .filter((note) => note.description === 'Person')
      .map((note) => [note.name, note.name]),
  );

  /*
   * The same people again, by surname, for the one case that needs it.
   *
   * Mail calls her Jennifer Irwin and Classroom calls her Mrs. Irwin. Slugged
   * separately those are two people, and the vault held both -- the entity
   * resolution failure this file warns about a hundred lines up, walked back
   * in through a display name.
   *
   * Only where the surname belongs to exactly one person already. Two Irwins
   * and nothing is merged, which is the honest outcome: a wrong merge is worse
   * than a duplicate, because it attributes one person's work to another.
   */
  const bySurname = new Map<string, string | null>();
  for (const slug of peopleBySlug.keys()) {
    const surname = slug.split('-').at(-1) as string;
    bySurname.set(surname, bySurname.has(surname) ? null : slug);
  }
  const soleBearer = (name: string): string | undefined => {
    const surname = slugForNote(name).split('-').at(-1) as string;
    return bySurname.get(surname) ?? undefined;
  };

  const result: MailImportResult = { written: 0, skipped: 0, people: 0 };

  /*
   * Episode names have to be unique and their ingredients are not.
   *
   * The name is the day plus the subject, and Classroom notifications reuse
   * both. Found on a real inbox as twenty written and eighteen on disk.
   */
  const uniqueName = (base: string): string => {
    let name = base;
    let suffix = 2;
    while (takenNames.has(name)) name = `${base}-${suffix++}`;
    takenNames.add(name);
    return name;
  };

  /*
   * Extract concurrently, write in order.
   *
   * A complete year is hundreds of messages and one model call each, which is
   * ten minutes sequentially. The writes stay serial because the vault has
   * state -- name uniqueness, which people already exist -- and racing on it
   * would produce exactly the duplicates the ids were meant to prevent.
   */
  /*
   * And nothing about a class they no longer take.
   *
   * Filtered before the extraction rather than after, because each message
   * costs a model call: the mail about one dropped course on a real account
   * runs to nearly two hundred messages, and paying to summarise them in order
   * to delete them is paying twice for nothing.
   *
   * This is the last place last year survives. Its course is gone and its
   * assignments went with it, and the mail stays precisely because the course
   * was removed thoroughly enough that nothing is left to sweep it with.
   */
  const setAside = messages.filter((message) => namesCourse(message.body, refusedTitles));

  /*
   * The teachers of a class they no longer take are still their teachers.
   *
   * Their mail is not kept, but they are: a teacher outlives the year they
   * taught, may teach this student again, and is most of what a vault can say
   * about a school. A Classroom notification carries the name in the sender, so
   * remembering the person costs nothing -- no extraction, no model call, just
   * the note itself.
   */
  for (const message of setAside) {
    const named = classroomSender(message.from, message.subject);
    if (!named) continue;

    const key = `classroom:${slugForNote(named)}`;
    if (peopleByAddress.has(key) || peopleBySlug.has(slugForNote(named))) continue;

    const note = slugForNote(named);
    await vault.write({
      name: note,
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      externalId: key,
      body: `${named.trim()}, who posts to Google Classroom.`,
    });
    peopleByAddress.set(key, note);
    peopleBySlug.set(note, note);
    const surname = note.split('-').at(-1) as string;
    bySurname.set(surname, bySurname.has(surname) ? null : note);
    result.people += 1;
  }

  /*
   * And nothing else about a class they no longer take.
   *
   * Set aside before the extraction rather than after, because each message is
   * a model call: the mail about one dropped course on a real account runs to
   * nearly two hundred messages, and paying to summarise them in order to
   * delete them is paying twice for nothing.
   */
  const pending = messages
    .filter((message) => !already.has(message.messageId))
    .filter((message) => !namesCourse(message.body, refusedTitles));
  let seen = 0;

  /*
   * Extract a chunk, write a chunk, repeat.
   *
   * Extracting everything before writing anything makes a half-hour import
   * all-or-nothing, and an interruption at minute twenty-nine costs every
   * model call it had already paid for. Since an import skips messages the
   * vault already has, whatever reached disk is work a re-run will not repeat
   * -- which is what makes a long import resumable rather than merely
   * restartable. The chunk is the unit at risk, and twenty-five of them is a
   * small enough thing to lose.
   */
  for (let start = 0; start < pending.length; start += CHUNK) {
    await extractAndWrite(pending.slice(start, start + CHUNK));
  }

  return result;

  async function extractAndWrite(batch: SchoolMessage[]): Promise<void> {
    const extracted = await pooled(batch, EXTRACT_CONCURRENCY, async (message) => {
      const known = classroomEpisode(message);
      if (known) {
        seen += 1;
        onProgress?.(seen, pending.length);
        return { message, parsed: known };
      }
      /*
       * Counted in a finally, so a message counts once however it went.
       * Otherwise a run of failures leaves the bar frozen and looking hung
       * at exactly the moment something has gone wrong.
       */
      try {
        const answer = await retrying(() =>
          // No tools. Not an omission -- the containment argument rests on it.
          llm.chat(
            {
              // Background work the student never waits on; medium is enough for a page
              // and a fifth of the reasoning bill.
              effort: 'medium',
              messages: chatFor(message, entities, neighbours),
              tools: undefined,
            },
            { userId },
          ),
        );
        return { message, parsed: parseExtraction(answer.content) };
      } catch {
        /*
         * One message failing is one message, not the import.
         *
         * A real run of a year of mail died on message six hundred: a single
         * 429 rejected the Promise.all and five hundred and ninety-nine good
         * extractions were discarded with it, having been paid for. Nothing
         * reached disk, so starting again meant paying again.
         */
        return { message, parsed: null };
      } finally {
        seen += 1;
        onProgress?.(seen, pending.length);
      }
    });

    for (const { message, parsed } of extracted) {
      const sender = parseSender(message.from);

      if (!parsed) {
        result.skipped += 1;
        continue;
      }
      if (!parsed.keep || parsed.what.trim() === '') continue;

      /*
       * A note for the person who sent it.
       *
       * "Who sent what" needs somebody to have been sent from, and Classroom
       * does not hand over teachers -- listCourses returns an id and a name and
       * nothing else. Senders at the school's own domain are the only place
       * people come from, and they are the most-linked nodes the vault lacked.
       */
      let personNote: string | undefined;
      /*
       * A Classroom notification names a teacher and hides them behind an
       * address every teacher shares.
       *
       * So identity comes from the name here and from the address everywhere
       * else. Keyed by the slug, which merges them with the same person's own
       * mail when they have written any, and stands alone when they have not
       * -- which is the case that matters, because a teacher who posts to
       * Classroom and never emails did not exist in this vault at all.
       */
      const viaClassroom = classroomSender(message.from, message.subject);
      const named = viaClassroom ?? parsed.actor;
      const key = viaClassroom
        ? `classroom:${slugForNote(viaClassroom)}`
        : sender.address.toLowerCase();

      const atSchool =
        viaClassroom !== null ||
        (domains ?? []).some((domain) => sender.address.toLowerCase().endsWith(`@${domain}`));

      if (
        atSchool &&
        (viaClassroom !== null || !AUTOMATED.test(sender.address)) &&
        named.trim() !== ''
      ) {
        // Whatever this message called them, a person already seen keeps the
        // note and the name they were given first.
        personNote =
          peopleByAddress.get(key) ??
          peopleBySlug.get(slugForNote(named)) ??
          (viaClassroom ? soleBearer(named) : undefined);

        if (!personNote) {
          personNote = slugForNote(named);
          await vault.write({
            name: personNote,
            kind: 'entity',
            source: 'gmail',
            description: 'Person',
            externalId: key,
            body: viaClassroom
              ? `${named.trim()}, who posts to Google Classroom.`
              : `${named.trim()}, at ${sender.address}.`,
          });
          peopleByAddress.set(key, personNote);
          peopleBySlug.set(personNote, personNote);
          const surname = personNote.split('-').at(-1) as string;
          bySurname.set(surname, bySurname.has(surname) ? null : personNote);
          result.people += 1;
        }
        allowed.add(personNote);
      }

      const about = parsed.about.filter((name) => allowed.has(name));
      const inCourse = parsed.inCourse.filter((name) => allowed.has(name));

      /*
       * The course this notification is about, made if nobody has made it.
       *
       * A class the school deleted, or archived beyond the states this app can
       * ask for, is gone from the API and still has a year of mail about it.
       * That mail could only link to courses that already had a note, so the
       * reference was dropped in silence -- no course, no link, and nothing
       * dangling to show anything had been lost.
       */
      if (viaClassroom) {
        const named = classroomCourse(message.body);
        if (named && !refused.has(named) && !tooOldToRecover(message.date, since)) {
          const slug = slugForNote(named);
          if (!knownCourses.has(slug)) {
            await vault.write({
              name: slug,
              kind: 'entity',
              source: 'gmail',
              description: 'Course',
              body: `${named}, on Google Classroom.\nKnown only from mail about it.`,
            });
            knownCourses.add(slug);
            allowed.add(slug);
          }
          if (!inCourse.includes(slug)) inCourse.push(slug);
        }
      }
      const occurred = isoTime(message.date);

      await vault.write({
        name: uniqueName(slugForNote(`${occurred.slice(0, 10)} ${message.subject}`)),
        kind: 'episode',
        source: 'gmail',
        description: parsed.what.trim().slice(0, 200),
        externalId: message.messageId,
        occurred,
        ...(parsed.actor.trim() ? { actor: parsed.actor.trim() } : {}),
        // Classroom's own word for what happened beats a summary of it.
        event:
          (viaClassroom ? classroomEvent(message.subject) : null) ?? (parsed.event as EpisodeEvent),
        sourceUrl: `https://mail.google.com/mail/u/0/#all/${message.messageId}`,
        body: [
          parsed.what.trim(),
          '',
          ...about.map((name) => `About [[${name}]]`),
          ...inCourse.map((name) => `In [[${name}]]`),
          ...(personNote ? [`By [[${personNote}]]`] : []),
          '',
          '## The message',
          '',
          `From: ${message.from}`,
          ...(message.to ? [`To: ${message.to}`] : []),
          ...(message.cc ? [`Cc: ${message.cc}`] : []),
          `Subject: ${message.subject}`,
          '',
          message.body.trim(),
        ]
          .join('\n')
          .trim(),
      });
      result.written += 1;
    }
  }
}

/**
 * How many messages are extracted and written before the next batch starts.
 *
 * The amount of paid-for work an interruption can destroy. Small enough to be
 * cheap to lose, large enough that the concurrency pool is never starved.
 */
export const CHUNK = 25;

/** How many extractions run at once. Enough to be quick, few enough to be polite. */
const EXTRACT_CONCURRENCY = 6;

async function pooled<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (true) {
        const index = next++;
        const item = items[index];
        if (item === undefined) return;
        out[index] = await fn(item);
      }
    }),
  );
  return out;
}

/** The one prompt this pass sends, built per message. */
function chatFor(
  message: SchoolMessage,
  entities: string[],
  neighbours?: ReadonlyMap<string, string[]>,
): ChatMessage[] {
  const shortlist = shortlistFor(message, entities, neighbours);
  return [
    { role: 'system', content: `${VAULT_WRITING.body}\n\n---\n\n${ASK}` },
    {
      role: 'user',
      content:
        `Names you may link to:\n${shortlist.join('\n') || '(none)'}\n\n` +
        `From: ${message.from}\n` +
        (message.to ? `To: ${message.to}\n` : '') +
        (message.cc ? `Cc: ${message.cc}\n` : '') +
        `Subject: ${message.subject}\nDate: ${message.date}\n\n` +
        message.body.slice(0, 6000),
    },
  ];
}

/**
 * Which entities to offer this message.
 *
 * A whole vault is hundreds of names and most of a prompt. Narrowing on shared
 * words keeps the list short and keeps the model choosing rather than scanning.
 */
function shortlistFor(
  message: SchoolMessage,
  entities: string[],
  neighbours: ReadonlyMap<string, string[]> = new Map(),
): string[] {
  const words = new Set(
    `${message.subject} ${message.body.slice(0, 800)}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4),
  );

  const direct = entities
    .map((name) => ({ name, score: name.split('-').filter((part) => words.has(part)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .map(({ name }) => name);

  /*
   * Whatever those notes link to, as well.
   *
   * Caught by the skills eval: an email about the Cold War essay never
   * contains the word "history", so the course was never offered and the
   * episode could not be linked to it -- the model was blamed for a choice it
   * was never given. An assignment already says which course it is part of, so
   * one hop out is free and is exactly the general thing the writing rules ask
   * to be linked alongside the specific one.
   */
  const known = new Set(entities);
  const withNeighbours = new Set(direct);
  for (const name of direct) {
    for (const neighbour of neighbours.get(name) ?? []) {
      // Only notes that exist. A wikilink can point at something that was
      // never written, and offering it asks the model to choose a target that
      // is then silently discarded.
      if (known.has(neighbour)) withNeighbours.add(neighbour);
    }
  }

  return [...withNeighbours].slice(0, 30);
}

/** Who links to whom, read off the [[wikilinks]] already in the notes. */
function neighbourMap(notes: { name: string; body: string }[]): Map<string, string[]> {
  return new Map(
    notes.map((note) => [
      note.name,
      [...note.body.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1] as string),
    ]),
  );
}

/** The model's answer, or nothing. A refusal and a truncation look the same. */
function parseExtraction(content: unknown): z.infer<typeof extraction> | null {
  if (typeof content !== 'string') return null;

  const text = content.trim().replace(/^```(?:json)?\s*/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = extraction.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** When it happened, not when it was read. Falls back to something sortable. */
function isoTime(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? '0000-01-01T00:00:00.000Z' : parsed.toISOString();
}

/**
 * Whether a notification is too old to justify making a course out of it.
 *
 * Only bounds RECOVERY, never the episode: last year's mail is still worth
 * keeping on the timeline, it just must not create a course note behind it.
 */
function tooOldToRecover(date: string | undefined, since: string | undefined): boolean {
  if (!since || !date) return false;
  const on = new Date(date);
  return !Number.isNaN(on.getTime()) && on.toISOString().slice(0, 10) < since;
}
