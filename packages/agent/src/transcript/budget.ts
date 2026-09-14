import { randomUUID } from 'node:crypto';
import type { AgentActivity } from '@contexto/shared';
import type { LlmRegistry } from '@contexto/llm';
import { compactTranscript } from './compaction.js';
import { estimateTranscriptTokens } from './render.js';
import type { TranscriptItem, TranscriptStore } from './types.js';

/**
 * Keeps a long-running chat's transcript inside the model's context window.
 *
 * A tutoring conversation with one student can run for weeks without a new
 * chat ever starting, and tool results -- a page of a textbook, a browser
 * snapshot -- are the biggest thing in it. Left alone the transcript grows
 * without bound and every turn eventually fails once it stops fitting. Two
 * rungs keep it bounded, in this order: clearing old tool results behind a
 * watermark, and -- when clearing alone still leaves the transcript too big
 * -- compacting the older turns into a handoff summary (compaction.ts).
 */
export interface ContextBudget {
  /** Above this estimated token count, old tool results start clearing. */
  clearToolResultsAboveTokens: number;
  /** How many of the most recent tool results stay verbatim once clearing runs. */
  keepRecentToolResults: number;
  /** Above this, even after clearing, whole turns get compacted. */
  compactAboveTokens: number;
  /** How many of the most recent user turns compaction leaves verbatim. */
  keepLastUserTurns: number;
}

/**
 * 40k tokens and 5 kept results, chosen around how a tutoring session
 * actually uses tools rather than around a token budget in the abstract.
 * Anthropic's own prompt caching keeps the last 3 tool uses ahead of its
 * cache boundary, so keeping fewer than that would clear results the
 * provider was about to discount anyway; a real session tends to open one
 * file and then ask a handful of follow-up questions about it before moving
 * on, and 5 covers that without also carrying the file opened before it. 40k
 * is comfortably below where a request starts costing real money, while
 * staying high enough that an ordinary short chat never triggers this at
 * all.
 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  clearToolResultsAboveTokens: 40_000,
  keepRecentToolResults: 5,
  compactAboveTokens: 80_000,
  keepLastUserTurns: 4,
};

/**
 * The watermark to append, or undefined when nothing should change. Pure.
 *
 * Clearing marks a watermark rather than rewriting the cleared items: render.ts
 * turns anything at or below it into a stub only at the moment it builds the
 * provider message, so the transcript itself -- and the rendered prefix in
 * front of the newly-cleared results -- stays byte-identical to what the last
 * request sent. That is what lets the provider's prompt cache keep hitting on
 * it; rewriting the stored tool results would change that prefix on every
 * turn from here on and pay full price for it forever.
 */
export function clearingWatermark(
  items: TranscriptItem[],
  budget: ContextBudget,
): { kind: 'tool_results_cleared'; throughSeq: number } | undefined {
  if (estimateTranscriptTokens(items) <= budget.clearToolResultsAboveTokens) return undefined;

  // The watermark already in force: clearing again must only look past it, or
  // it would re-select results an earlier pass already decided to keep.
  let watermark = -1;
  for (const item of items) {
    if (item.payload.kind === 'tool_results_cleared') watermark = item.payload.throughSeq;
  }

  const uncleared = items.filter(
    (item) => item.payload.kind === 'tool_result' && item.seq > watermark,
  );
  if (uncleared.length <= budget.keepRecentToolResults) return undefined;

  const throughSeq = uncleared[uncleared.length - budget.keepRecentToolResults - 1]!.seq;
  return { kind: 'tool_results_cleared', throughSeq };
}

/**
 * Applies the budget to a turn's transcript before it is rendered.
 *
 * Clearing first, then compaction on what clearing left: throwing away stale
 * tool results is free and often enough on its own, so an ordinary chat never
 * pays for a summariser call at all. A result cleared here is still shown to
 * the summariser if compaction follows, capped -- that pass is the last
 * chance to keep whatever mattered in it before the turn it belonged to
 * leaves the transcript for good.
 */
export async function applyBudget(
  deps: { llm: Pick<LlmRegistry, 'chat'>; transcript: TranscriptStore },
  options: {
    agentId: string;
    userId: string;
    items: TranscriptItem[];
    budget: ContextBudget;
    signal?: AbortSignal;
    onActivity?: (a: AgentActivity) => void;
  },
): Promise<TranscriptItem[]> {
  let items = options.items;

  const watermark = clearingWatermark(items, options.budget);
  if (watermark) {
    const appended = await deps.transcript.append([
      { agentId: options.agentId, turnId: randomUUID(), payload: watermark },
    ]);
    items = [...items, ...appended];
  }

  if (estimateTranscriptTokens(items) > options.budget.compactAboveTokens) {
    // The summariser call takes seconds the student is waiting through, with
    // nothing else on screen to explain them.
    options.onActivity?.({ kind: 'thinking' });
    const compacted = await compactTranscript(deps, {
      agentId: options.agentId,
      userId: options.userId,
      items,
      budget: options.budget,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (compacted) items = compacted;
  }

  return items;
}
