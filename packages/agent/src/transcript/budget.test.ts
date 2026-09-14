import { describe, expect, it, vi } from 'vitest';
import { applyBudget, clearingWatermark, DEFAULT_CONTEXT_BUDGET } from './budget.js';
import { InMemoryTranscriptStore } from './in-memory.js';
import type { ContextBudget } from './budget.js';
import type { TranscriptItem, TranscriptPayload } from './types.js';

function item(seq: number, payload: TranscriptPayload, tokenEstimate = 1): TranscriptItem {
  return {
    id: `id-${seq}`,
    agentId: 'agent-1',
    seq,
    turnId: 'turn-1',
    payload,
    tokenEstimate,
    createdAt: new Date(),
  };
}

function toolResult(seq: number): TranscriptItem {
  return item(seq, {
    kind: 'tool_result',
    toolCallId: `call-${seq}`,
    toolName: 'probe',
    content: 'result',
  });
}

/** Over threshold with a single item, without needing a wall of content. */
const tinyBudget: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET, clearToolResultsAboveTokens: 0 };

describe('clearingWatermark', () => {
  it('does nothing under the token threshold', () => {
    const items = [toolResult(1), toolResult(2)];
    expect(clearingWatermark(items, DEFAULT_CONTEXT_BUDGET)).toBeUndefined();
  });

  it('clears down to the kept count once over threshold', () => {
    const items = Array.from({ length: 7 }, (_, i) => toolResult(i + 1));
    const budget: ContextBudget = { ...tinyBudget, keepRecentToolResults: 5 };

    const watermark = clearingWatermark(items, budget);

    // 7 results, keep the last 5 verbatim -> clear through the 2nd result's seq.
    expect(watermark).toEqual({ kind: 'tool_results_cleared', throughSeq: 2 });
  });

  it('is idempotent once the resulting watermark is already present', () => {
    const items = Array.from({ length: 7 }, (_, i) => toolResult(i + 1));
    const budget: ContextBudget = { ...tinyBudget, keepRecentToolResults: 5 };
    const first = clearingWatermark(items, budget);

    const withWatermark = [...items, item(8, first!)];

    expect(clearingWatermark(withWatermark, budget)).toBeUndefined();
  });

  it('never returns the seq of a non-tool item', () => {
    // Tool results interleaved with other items, so the watermark can only be
    // right if it indexes within the filtered tool_result list, not the raw one.
    const items = [
      item(1, { kind: 'user', content: 'hi' }),
      toolResult(2),
      item(3, { kind: 'assistant', content: 'ok' }),
      toolResult(4),
      item(5, { kind: 'assistant', content: 'ok' }),
      toolResult(6),
      item(7, { kind: 'assistant', content: 'ok' }),
      toolResult(8),
      item(9, { kind: 'assistant', content: 'ok' }),
      toolResult(10),
      item(11, { kind: 'assistant', content: 'ok' }),
      toolResult(12),
      item(13, { kind: 'assistant', content: 'ok' }),
      toolResult(14),
    ];
    const budget: ContextBudget = { ...tinyBudget, keepRecentToolResults: 5 };

    const watermark = clearingWatermark(items, budget);

    const toolSeqs = items.filter((i) => i.payload.kind === 'tool_result').map((i) => i.seq);
    expect(watermark).toBeDefined();
    expect(toolSeqs).toContain(watermark!.throughSeq);
    expect(watermark!.throughSeq).toBe(4);
  });
});

describe('applyBudget', () => {
  it('appends the watermark and returns the items including it', async () => {
    const items = Array.from({ length: 7 }, (_, i) => toolResult(i + 1));
    const budget: ContextBudget = { ...tinyBudget, keepRecentToolResults: 5 };
    const transcript = new InMemoryTranscriptStore();
    const llm = { chat: vi.fn() };

    const result = await applyBudget(
      { llm, transcript },
      { agentId: 'agent-1', userId: 'user-1', items, budget },
    );

    // Clearing alone never needs the model: it only marks a watermark.
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result).toHaveLength(8);
    expect(result.at(-1)?.payload).toEqual({ kind: 'tool_results_cleared', throughSeq: 2 });
  });

  it('returns the items unchanged when nothing is due', async () => {
    const items = [toolResult(1)];
    const transcript = new InMemoryTranscriptStore();
    const llm = { chat: vi.fn() };

    const result = await applyBudget(
      { llm, transcript },
      { agentId: 'agent-1', userId: 'user-1', items, budget: DEFAULT_CONTEXT_BUDGET },
    );

    expect(result).toBe(items);
    expect(llm.chat).not.toHaveBeenCalled();
  });
});
