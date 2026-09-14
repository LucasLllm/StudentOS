import { randomUUID } from 'node:crypto';
import type { LlmRegistry } from '@contexto/llm';
import { COMPACTION } from '../prompts/documents.js';
import { truncateToolResult } from './truncate.js';
import type { ContextBudget } from './budget.js';
import type { TranscriptItem, TranscriptStore } from './types.js';

/**
 * Turns the older part of a long chat into a handoff summary.
 *
 * The second rung of the context ladder: once clearing tool results is no
 * longer enough, whole turns have to go, and what replaces them is a summary
 * we write ourselves with a prompt of our own. Neither provider's built-in
 * compaction covers both of the models this agent runs on, and a summary the
 * provider makes is one we can neither read back in a transcript view nor
 * test; ours is an ordinary transcript item, inspectable and asserted on.
 *
 * A failed summary skips rather than fails. Compaction runs between the
 * student pressing send and the model answering, so a summariser that throws
 * or comes back empty must cost them nothing more than an oversized request
 * -- which is still an answer, where a thrown error is a lost turn.
 *
 * The cut is always a `user` item, never an arbitrary index. A turn is a
 * question and everything the agent did about it; cutting inside one would
 * hand the next context window tool results whose request no longer exists.
 * Cutting at a user message also keeps the question currently in flight out
 * of the summariser entirely -- it is answered verbatim, never paraphrased.
 */

/** The seq of the user item that starts the kept tail, or undefined when there are too few turns. Pure. */
export function compactionCut(
  items: TranscriptItem[],
  keepLastUserTurns: number,
): number | undefined {
  const users = items.filter((item) => item.payload.kind === 'user');
  // Undefined when the lookup falls off either end: fewer user turns than the
  // tail keeps, so there is nothing older to summarise.
  return users[users.length - keepLastUserTurns]?.seq;
}

/** Plain text of everything before the cut, for the summariser. Pure. */
export function renderForSummary(items: TranscriptItem[], cutSeq: number): string {
  const parts: string[] = [];

  for (const item of items) {
    const payload = item.payload;

    // A compaction item is loaded ahead of the tail it covers but carries a
    // later seq than any of it, so it is included on kind rather than on
    // position -- the summariser updates it instead of starting over.
    if (payload.kind === 'compaction') {
      parts.push(`Earlier summary:\n${payload.summary}`);
      continue;
    }
    if (item.seq >= cutSeq) continue;

    switch (payload.kind) {
      case 'user':
        parts.push(`Student: ${payload.content}`);
        break;
      case 'assistant': {
        const lines: string[] = [];
        // A turn that only called tools has no text of its own; an empty
        // "Agent:" line would tell the summariser nothing.
        if (payload.content.trim()) lines.push(`Agent: ${payload.content}`);
        for (const call of payload.toolCalls ?? []) {
          lines.push(`Agent called ${call.name}(${call.arguments})`);
        }
        if (lines.length > 0) parts.push(lines.join('\n'));
        break;
      }
      case 'tool_result': {
        // 2,000 characters each: a page of a textbook is worth a paragraph of
        // summary, and a dozen of them at full length would not fit the
        // summariser's own context window.
        const { text } = truncateToolResult(payload.content, 2_000);
        parts.push(`Tool ${payload.toolName} returned: ${text}`);
        break;
      }
      case 'tool_results_cleared':
        break;
    }
  }

  return parts.join('\n\n');
}

export async function compactTranscript(
  deps: { llm: Pick<LlmRegistry, 'chat'>; transcript: TranscriptStore },
  options: {
    agentId: string;
    userId: string;
    items: TranscriptItem[];
    budget: ContextBudget;
    signal?: AbortSignal;
  },
): Promise<TranscriptItem[] | undefined> {
  const cut = compactionCut(options.items, options.budget.keepLastUserTurns);
  if (cut === undefined) return undefined;

  let summary: string;
  try {
    const response = await deps.llm.chat(
      {
        messages: [
          { role: 'system', content: COMPACTION.body },
          { role: 'user', content: renderForSummary(options.items, cut) },
        ],
        // No tools: this call reads a conversation, it does not act in one.
        // Medium effort because the work is recall, not reasoning, and the
        // student is waiting for their answer behind it.
        effort: 'medium',
        maxOutputTokens: 4_000,
      },
      {
        userId: options.userId,
        agentId: options.agentId,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    summary = response.content.trim();
  } catch (cause) {
    console.warn('compaction skipped', cause);
    return undefined;
  }

  if (!summary) {
    console.warn('compaction skipped', 'the summariser returned no text');
    return undefined;
  }

  await deps.transcript.append([
    {
      agentId: options.agentId,
      turnId: randomUUID(),
      payload: { kind: 'compaction', summary, coversThroughSeq: cut - 1 },
    },
  ]);

  // Reloaded rather than assembled here: the store owns which items a
  // compaction supersedes, and deriving that twice is how the two drift.
  return deps.transcript.load(options.agentId);
}
