import type { LlmProvider } from '@contexto/llm';
import { retrying } from '../vault/retry.js';

/**
 * A project's memory: what its chats have settled, for the chats after them.
 *
 * The project's counterpart to the student's chats page, and kept apart from
 * it on purpose. What is decided in a project -- the budget, the angle, what
 * the teacher said about the draft -- belongs to the project, and an ordinary
 * chat that knew it would be the project leaking into everything else.
 *
 * Rewritten whole and bounded, for the reason the chats page is: a limit is
 * what forces the decision about what to drop. It is carried in every project
 * chat's frozen block, so its size is paid on every turn of every chat.
 */

/** About 1,500 tokens. */
export const PROJECT_MEMORY_LIMIT = 6_000;

const NOTHING = 'UNCHANGED';

const PROMPT = [
  "You keep a project's memory: short notes of what its conversations have established, so",
  'the next conversation in the project can build on them without being told again.',
  '',
  'Keep: decisions made, facts found, what the student wants and does not want, what is',
  'finished and what is still to do, and anything they said the project must or must not do.',
  'Drop: small talk, questions that were fully answered and will not come up again, and',
  'anything already in the goal. Merge with what is already kept; correct it where the new',
  'conversation changed it; remove what is no longer true.',
  '',
  'Write short bullet points. Reply with the whole memory as it should now read, or with',
  `${NOTHING} alone if the conversation established nothing worth keeping.`,
].join('\n');

function capped(text: string): string {
  if (text.length <= PROJECT_MEMORY_LIMIT) return text;
  const cut = text.slice(0, PROJECT_MEMORY_LIMIT);
  // On a line boundary, so the last note is not left half a sentence.
  const line = cut.lastIndexOf('\n');
  return (line > PROJECT_MEMORY_LIMIT / 2 ? cut.slice(0, line) : cut).trimEnd();
}

/** The new memory, or null when it should stay as it is. */
export async function updateProjectMemory(
  { llm }: { llm: Pick<LlmProvider, 'chat'> },
  input: {
    name: string;
    instructions: string;
    memory: string;
    exchanges: string[];
    userId: string;
  },
): Promise<string | null> {
  if (input.exchanges.length === 0) return null;

  const answer = await retrying(() =>
    llm.chat(
      {
        // Background work nobody waits on: medium, as the chats page is.
        effort: 'medium',
        messages: [
          { role: 'system', content: PROMPT },
          {
            role: 'user',
            content: [
              `Project: ${input.name}`,
              `Goal: ${input.instructions || '(none given)'}`,
              '',
              input.memory.trim()
                ? `The memory as it stands:\n\n${input.memory.trim()}`
                : 'Nothing has been kept for this project yet.',
              '',
              'What has been said since, oldest first:',
              '',
              input.exchanges.join('\n\n'),
              '',
              `The memory may be at most ${PROJECT_MEMORY_LIMIT} characters.`,
            ].join('\n'),
          },
        ],
      },
      { userId: input.userId },
    ),
  );

  const said = typeof answer.content === 'string' ? answer.content.trim() : '';
  if (said === '' || said.toUpperCase().startsWith(NOTHING)) return null;
  const next = capped(said);
  return next === input.memory.trim() ? null : next;
}
