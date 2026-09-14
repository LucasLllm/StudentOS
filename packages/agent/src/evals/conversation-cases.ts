import { FILLER } from './memory-cases.js';
import type { ConversationCase, ConversationTurn } from './conversation-grader.js';

/**
 * Conversations long enough to break the context window.
 *
 * The memory eval seeds a history and asks one question. These say every turn
 * out loud, through the real turn loop, so that clearing and compaction
 * actually happen to the transcript between the fact being stated and being
 * asked for. That is the only way to measure what the budget throws away: a
 * seeded history never gets compacted, so it can never show the summary
 * losing the thing the student needed.
 *
 * The distractors are the memory eval's filler -- ordinary school chatter
 * rather than padding, because a window full of plausible near-misses is the
 * harder problem and the one a real student produces.
 */

/** The student half of each filler exchange; the agent's half it will say itself. */
const CHATTER: string[] = FILLER.map((row) =>
  row.slice('Student: '.length, row.indexOf('\nAgent: ')),
);

/**
 * `count` distractor turns, cycling from `from`.
 *
 * Cycling rather than demanding a unique question per turn: twenty turns is
 * more small talk than anyone wants to write, and a repeated question is
 * itself realistic -- students ask the same thing twice.
 */
function distractions(count: number, from = 0): ConversationTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    say: CHATTER[(from + i) % CHATTER.length] as string,
  }));
}

export const CONVERSATION_CASES: ConversationCase[] = [
  /*
   * The needle: one fact, stated on turn one, asked for on turn twenty.
   *
   * By then the opening turn is either behind the compaction boundary or
   * summarised into it, so passing means either the summary kept the name and
   * the date or memory_search went and found them. Failing means the harness
   * quietly dropped the only thing in the conversation that mattered.
   */
  {
    id: 'needle-teacher',
    category: 'needle',
    turns: [
      { say: 'my chemistry teacher is Ms Okonkwo and the paper is on 14 May' },
      ...distractions(18),
      {
        say: 'who teaches me chemistry and when is the paper?',
        expect: ['Okonkwo', '14 May'],
      },
    ],
  },

  /*
   * The goal: a task of several steps, interrupted twice.
   *
   * What is being measured is whether the agent still knows where it got to
   * after the conversation wandered off to Lima and back. The reply must name
   * a step that is still to come -- so `expectAny` over the later steps,
   * because how far it got depends on how it chose to work -- and must not
   * open by answering the distraction again, which is what losing the thread
   * looks like.
   *
   * Turn one supplies the essay question, word count, and deadline: an
   * outline needs a question to outline, and a brief that never gives one
   * makes the pending step unreachable -- the agent correctly asks for it
   * instead of guessing, and can never get to draft, intro, or source.
   */
  {
    id: 'goal-essay',
    category: 'goal',
    turns: [
      {
        say:
          "help me get my history essay done. The question is 'To what extent was the " +
          "Cold War inevitable after 1945?', 1500 words, due next Friday. Do it in three " +
          'steps: first an outline, then a draft intro, then a source list. Start with ' +
          'the outline now.',
      },
      ...distractions(3),
      { say: "actually wait, what's the capital of Peru" },
      ...distractions(3, 3),
      { say: 'hang on, can you explain what a p-value is' },
      ...distractions(5, 6),
      {
        say: "ok where were we with the essay, what's next?",
        expectAny: ['draft', 'intro', 'source'],
        reject: ['capital', 'Peru'],
      },
    ],
  },

  /*
   * The tool result: read on turn three, asked about on turn eighteen.
   *
   * The probe answers once and then fails, so the agent cannot recover the
   * answer by calling it again -- it either kept what the tool said or it did
   * not. Clearing removes old tool results first and hardest, which makes
   * this the case most likely to break, and `unavailable` in the reply means
   * the agent tried the tool again and read its failure back as the answer.
   */
  {
    id: 'tool-recall-classroom',
    category: 'tool-recall',
    turns: [
      ...distractions(2),
      { say: "check my classroom for what's due this week" },
      ...distractions(14, 2),
      {
        say: 'remind me what was due from classroom?',
        expect: ['lab report', 'Thursday'],
        reject: ['unavailable'],
      },
    ],
  },
];
