/**
 * Deciding whether the agent actually remembered.
 *
 * Same discipline as rules.ts: no model in the loop. A grader that asks a
 * model whether the answer was right cannot tell us whether the model got
 * better, and it fails in the same direction as the thing it is grading.
 *
 * The categories are LongMemEval's, adapted to a student: recalling a fact
 * stated once, combining facts from different conversations, preferring a
 * corrected fact over the one it replaced, resolving a relative time
 * reference, and declining to answer something it was never told.
 */

export type MemoryCategory =
  /** The fact is inside the recency window. Guards the recall tier. */
  | 'continuity'
  | 'extraction'
  | 'multi-session'
  | 'update'
  | 'temporal'
  | 'abstention'
  /** Many entities at once. Built to find the flat profile's ceiling. */
  | 'dense';

export interface MemoryCase {
  id: string;
  category: MemoryCategory;
  /** Prior exchanges, oldest first, as the agent would have recorded them. */
  history: string[];
  question: string;
  /** Every one of these must appear in the reply. */
  expect?: string[];
  /** None of these may appear -- the superseded answer, usually. */
  reject?: string[];
  /** The reply must open by admitting it does not know. */
  abstain?: boolean;
}

export interface Grade {
  passed: boolean;
  why: string;
}

/**
 * Fold the punctuation models actually emit onto the ASCII we match against.
 *
 * The first run of this eval scored three correct abstentions as failures:
 * every pattern spelled "don't" with a straight apostrophe and the model wrote
 * a typographic one. Normalising once here is the only place that can go
 * wrong, rather than every pattern having to remember.
 */
export function normalise(text: string): string {
  return text
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '--');
}

/** Escape a term so it can go inside a word-boundary match. */
export function term(text: string): RegExp {
  return new RegExp(`\\b${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
}

/**
 * Ways of saying "you never told me this".
 *
 * responding.md asks for exactly this -- "say you do not know it rather than
 * producing a confident guess" -- so the abstention category is measuring a
 * promise the prompt already makes.
 */
const ADMITS_NOT_KNOWING = [
  /\bdon'?t know\b/i,
  /\bdo not know\b/i,
  /\bnot sure\b/i,
  /\bno record\b/i,
  /\bnever (?:told|mentioned|said)\b/i,
  /\bhaven'?t told me\b/i,
  /\bhave not told me\b/i,
  /\bdidn'?t mention\b/i,
  /\bdid not mention\b/i,
  /\bcan'?t find\b/i,
  /\bcannot find\b/i,
  // "I couldn't find anything in your records" -- the commonest way a model
  // says it does not know, and missing from the first version of this list.
  /\bcould ?n'?t find\b/i,
  /\bcould not find\b/i,
  /\bdid ?n'?t find\b/i,
  /\bno (?:record|mention|note) of\b/i,
  /\bnothing (?:about|in)\b/i,
  /\bI don'?t have\b/i,
  /\bno idea\b/i,
];

/**
 * The reply's opening clause, up to the first break.
 *
 * Abstention is judged on the opening rather than anywhere in the reply,
 * because "It's Mr Harrison, though I'm not sure" contains an admission and is
 * still confabulation -- the student acts on the name. An honest "I don't
 * know" leads with it.
 */
export function opening(reply: string): string {
  const [first] = reply.trim().split(/[,.;:!?]|\s--?\s|\n/);
  return first ?? '';
}

export function gradeReply(testCase: MemoryCase, rawReply: string): Grade {
  const reply = normalise(rawReply);

  if (testCase.abstain) {
    const admitted = ADMITS_NOT_KNOWING.some((pattern) => pattern.test(opening(reply)));
    return admitted
      ? { passed: true, why: 'admitted it was not told' }
      : { passed: false, why: 'did not abstain -- invented an answer instead of admitting' };
  }

  const missing = (testCase.expect ?? []).filter((want) => !term(want).test(reply));
  if (missing.length > 0) {
    return { passed: false, why: `missing: ${missing.join(', ')}` };
  }

  /*
   * Judged on the opening clause, not the whole reply.
   *
   * "Ms Okonkwo teaches you chemistry now. Mr Ali left at half term" is the
   * right answer with useful context attached, and rejecting it for containing
   * the old name would score helpfulness as failure. What must not happen is
   * the stale fact being offered AS the answer, which is what leading with it
   * means.
   */
  const stale = (testCase.reject ?? []).filter((no) => term(no).test(opening(reply)));
  if (stale.length > 0) {
    return { passed: false, why: `led with the stale answer: ${stale.join(', ')}` };
  }

  return { passed: true, why: 'recalled' };
}
