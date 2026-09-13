import { describe, expect, it } from 'vitest';
import {
  COMPACTION_HANDOFF,
  estimateTranscriptTokens,
  renderTranscript,
  renderUserItem,
} from './render.js';
import type { TranscriptItem, TranscriptPayload } from './types.js';

function item(
  seq: number,
  payload: TranscriptPayload,
  extra: Partial<TranscriptItem> = {},
): TranscriptItem {
  return {
    id: `id-${seq}`,
    agentId: 'agent-1',
    seq,
    turnId: 'turn-1',
    payload,
    tokenEstimate: 1,
    createdAt: new Date(),
    ...extra,
  };
}

describe('renderUserItem', () => {
  it('renders a student message with its files once, in front of the words', () => {
    const content = renderUserItem({
      kind: 'user',
      content: 'what is x',
      attachments: [{ name: 'sheet.md', body: 'x=2' }],
    });
    expect(content).toContain('## sheet.md');
    expect(content).toContain('x=2');
    expect(content.endsWith('what is x')).toBe(true);
  });
});

describe('renderTranscript', () => {
  it('carries the provider payload on the assistant message', () => {
    const providerPayload = { format: 'anthropic_messages' as const, items: [{ foo: 'bar' }] };
    const messages = renderTranscript([
      item(1, { kind: 'assistant', content: 'hi there' }, { providerPayload }),
    ]);
    expect(messages).toEqual([
      { role: 'assistant', content: 'hi there', payload: providerPayload },
    ]);
  });

  it('renders a tool result under its call id', () => {
    const messages = renderTranscript([
      item(1, {
        kind: 'tool_result',
        toolCallId: 'call_1',
        toolName: 'vault_open',
        content: 'file contents',
      }),
    ]);
    expect(messages).toEqual([{ role: 'tool', toolCallId: 'call_1', content: 'file contents' }]);
  });

  it('replaces tool results up to the watermark with a stub that names the tool', () => {
    const messages = renderTranscript([
      item(2, {
        kind: 'tool_result',
        toolCallId: 'call_1',
        toolName: 'vault_open',
        content: 'a'.repeat(20),
      }),
      item(4, {
        kind: 'tool_result',
        toolCallId: 'call_2',
        toolName: 'vault_open',
        content: 'kept content',
      }),
      item(3, { kind: 'tool_results_cleared', throughSeq: 3 }),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toContain('cleared');
    expect(messages[0]!.content).toContain('vault_open');
    expect(messages[1]).toEqual({ role: 'tool', toolCallId: 'call_2', content: 'kept content' });
  });

  it('renders a compaction summary as a user message with the handoff first', () => {
    const messages = renderTranscript([
      item(9, { kind: 'compaction', summary: 'Summary text', coversThroughSeq: 2 }),
    ]);
    expect(messages).toEqual([{ role: 'user', content: `${COMPACTION_HANDOFF}\n\nSummary text` }]);
  });
});

describe('estimateTranscriptTokens', () => {
  it('estimates from the last observed request size plus what came after', () => {
    const items = [
      item(
        5,
        {
          kind: 'assistant',
          content: 'reply',
          usage: { inputTokens: 10_000, cachedInputTokens: 0 },
        },
        { tokenEstimate: 999 },
      ),
      item(6, { kind: 'user', content: 'next' }, { tokenEstimate: 50 }),
    ];
    expect(estimateTranscriptTokens(items)).toBe(10_050);
  });

  it('ignores a request size observed before the latest compaction', () => {
    const items = [
      item(9, { kind: 'compaction', summary: 'S', coversThroughSeq: 2 }, { tokenEstimate: 5 }),
      item(
        3,
        { kind: 'assistant', content: 'old', usage: { inputTokens: 90_000, cachedInputTokens: 0 } },
        { tokenEstimate: 7 },
      ),
      item(4, { kind: 'user', content: 'kept' }, { tokenEstimate: 20 }),
      item(5, { kind: 'assistant', content: 'later' }, { tokenEstimate: 30 }),
    ];
    expect(estimateTranscriptTokens(items)).toBe(5 + 7 + 20 + 30);
  });
});
