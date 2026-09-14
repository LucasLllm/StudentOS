import { z } from 'zod';
import type { Tool } from './types.js';

/**
 * Looking things up in the agent's own history.
 *
 * A turn now replays the whole chat transcript, so it already has this
 * conversation in front of it without calling anything. What that replay
 * cannot hold is everything said in earlier conversations, so this is how
 * the agent reaches back beyond the current chat -- searched on demand, and
 * costing nothing on a turn that does not need it.
 */

const inputSchema = z.object({
  query: z
    .string()
    .min(2)
    .describe('Words to look for. A name, a subject, a teacher, a topic they mentioned.'),
  limit: z.number().int().min(1).max(20).optional().describe('How many to return. Defaults to 8.'),
});

export interface MemoryHit {
  when: string;
  what: string;
}

export const searchMemory: Tool<z.infer<typeof inputSchema>, MemoryHit[] | string> = {
  id: 'memory_search',
  /*
   * The description carries the trigger, not just the capability.
   *
   * A model that reads "searches memory" calls this when a student says
   * "remember when", and never when they say "what did my chemistry teacher
   * say about the deadline" -- which is the case that actually needs it, and
   * the one the recency window will silently miss.
   */
  description:
    'Search everything this student has said to you before, beyond the recent exchanges you ' +
    'can already see. Use it whenever they refer to something you cannot find in front of ' +
    'you: an earlier conversation, a preference they mentioned once, a decision you made ' +
    'together, a name or a date from weeks ago. Prefer calling it over telling them you do ' +
    'not remember.',
  inputSchema,
  async execute(input, ctx) {
    if (!ctx.memory) {
      // Absent only in a deployment wired without a memory store. Saying so
      // plainly beats an empty result, which reads as "nothing happened".
      return 'Memory search is not available in this deployment.';
    }

    const hits = await ctx.memory.search(ctx.agentId, input.query, input.limit ?? 8);

    if (hits.length === 0) {
      return `Nothing in memory matches "${input.query}".`;
    }

    return hits.map((hit) => ({
      when: hit.occurredAt.toISOString(),
      what: hit.content,
    }));
  },
};
