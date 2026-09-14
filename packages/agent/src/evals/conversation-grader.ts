import { normalise, opening, term } from './memory-grader.js';

/**
 * Deciding whether a long conversation kept what mattered.
 *
 * memory-grader.ts judges one question asked of a seeded history. This judges
 * a turn of a conversation the agent actually lived through, where the fact
 * being asked about was said twenty turns ago and has since been cleared,
 * compacted, or both. The failure it exists to catch is a harness that keeps
 * the conversation inside the context window by throwing away the part the
 * student cared about -- which looks like a working agent right up until
 * someone asks it to remember.
 *
 * No model in the loop, for the same reason as the memory grader: a judge
 * that is the thing being judged fails in the same direction as it.
 */

export type ConversationCategory =
  /** One fact, said once at the start, asked for at the end. */
  | 'needle'
  /** A multi-turn goal that has to survive being interrupted. */
  | 'goal'
  /** A tool result from early on, asked about long after it was cleared. */
  | 'tool-recall';

export interface ConversationTurn {
  /** What the student says on this turn. */
  say: string;
  /** Every one of these must appear in the reply. */
  expect?: string[];
  /**
   * At least one of these must appear.
   *
   * The goal case cannot know how far the agent got before it was
   * interrupted, only that the step it names next is one that is still to
   * come. Demanding a particular step would score a correct answer as a
   * failure whenever the agent worked faster or slower than the case's author
   * imagined.
   */
  expectAny?: string[];
  /** None of these may open the reply -- the distraction, usually. */
  reject?: string[];
}

export interface ConversationCase {
  id: string;
  category: ConversationCategory;
  /** Said in order, one per turn, through the same agent and transcript. */
  turns: ConversationTurn[];
}

export function gradeTurn(
  turn: ConversationTurn,
  rawReply: string,
): { passed: boolean; why: string } {
  const reply = normalise(rawReply);

  const missing = (turn.expect ?? []).filter((want) => !term(want).test(reply));
  if (missing.length > 0) {
    return { passed: false, why: `missing: ${missing.join(', ')}` };
  }

  const alternatives = turn.expectAny ?? [];
  if (alternatives.length > 0 && !alternatives.some((want) => term(want).test(reply))) {
    return { passed: false, why: `named none of: ${alternatives.join(', ')}` };
  }

  /*
   * Judged on the opening clause, exactly as the memory grader judges a stale
   * answer. "Next is the draft intro. The capital of Peru was a detour" has
   * answered the question and then referred back to the distraction, which is
   * a good reply; leading with Lima is the agent having lost the thread.
   */
  const derailed = (turn.reject ?? []).filter((no) => term(no).test(opening(reply)));
  if (derailed.length > 0) {
    return { passed: false, why: `led with the distraction: ${derailed.join(', ')}` };
  }

  return { passed: true, why: 'answered' };
}
