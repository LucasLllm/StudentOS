import { describe, expect, it, vi } from 'vitest';
import { compactionCut, compactTranscript, renderForSummary } from './compaction.js';
import { DEFAULT_CONTEXT_BUDGET } from './budget.js';
import { InMemoryTranscriptStore } from './in-memory.js';
import { COMPACTION } from '../prompts/documents.js';
import type { ContextBudget } from './budget.js';
import type { TranscriptItem, TranscriptPayload } from './types.js';

function item(seq: number, payload: TranscriptPayload): TranscriptItem {
  return {
    id: `id-${seq}`,
    agentId: 'agent-1',
    seq,
    turnId: `turn-${seq}`,
    payload,
    tokenEstimate: 1,
    createdAt: new Date(),
  };
}

/** `count` user/assistant pairs at seqs 1,2 / 3,4 / ... -- one exchange each. */
function conversation(count: number): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (let n = 1; n <= count; n += 1) {
    items.push(item(n * 2 - 1, { kind: 'user', content: `question ${n}` }));
    items.push(item(n * 2, { kind: 'assistant', content: `answer ${n}` }));
  }
  return items;
}

/** Writes `count` exchanges into a store and hands back what a turn would load. */
async function storedConversation(
  store: InMemoryTranscriptStore,
  count: number,
): Promise<TranscriptItem[]> {
  for (let n = 1; n <= count; n += 1) {
    await store.append([
      { agentId: 'agent-1', turnId: `turn-${n}`, payload: { kind: 'user', content: `q${n}` } },
      { agentId: 'agent-1', turnId: `turn-${n}`, payload: { kind: 'assistant', content: `a${n}` } },
    ]);
  }
  return store.load('agent-1');
}

function chatReturning(content: string) {
  return vi.fn(async () => ({
    content,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    finishReason: 'stop' as const,
  }));
}

/** `compactTranscript`'s deps, typed the way the production call site passes them. */
function depsWith(chat: (...args: never[]) => Promise<unknown>, store: InMemoryTranscriptStore) {
  return { llm: { chat }, transcript: store } as unknown as Parameters<typeof compactTranscript>[0];
}

const budgetKeeping = (keepLastUserTurns: number): ContextBudget => ({
  ...DEFAULT_CONTEXT_BUDGET,
  keepLastUserTurns,
});

describe('compactionCut', () => {
  it('leaves a short conversation alone', () => {
    // 3 user turns, keeping the last 4: there is nothing older to summarise.
    expect(compactionCut(conversation(3), 4)).toBeUndefined();
  });

  it('leaves a conversation with exactly the kept turns alone', () => {
    // The boundary that matters: 4 user turns keeping 4 leaves nothing before
    // the cut, and a summariser handed an empty conversation invents one.
    expect(compactionCut(conversation(4), 4)).toBeUndefined();
  });

  it('cuts at the user turn that starts the kept tail', () => {
    const items = conversation(6);

    // Users sit at seqs 1,3,5,7,9,11; keeping the last 4 starts at the 4th
    // from the end, seq 5.
    expect(compactionCut(items, 4)).toBe(5);
  });
});

describe('renderForSummary', () => {
  it('renders everything before the cut and nothing at or after it', () => {
    const items = [
      ...conversation(2),
      item(5, {
        kind: 'assistant',
        content: 'looking',
        toolCalls: [{ id: 'c1', name: 'vault_open', arguments: '{"name":"maths"}' }],
      }),
      item(6, { kind: 'tool_result', toolCallId: 'c1', toolName: 'vault_open', content: 'notes' }),
      item(7, { kind: 'user', content: 'question 4' }),
    ];

    const text = renderForSummary(items, 7);

    expect(text).toContain('Student: question 1');
    expect(text).toContain('Agent: answer 1');
    expect(text).toContain('Agent called vault_open({"name":"maths"})');
    expect(text).toContain('Tool vault_open returned: notes');
    // The question mid-flight is answered by the turn, never summarised away.
    expect(text).not.toContain('question 4');
  });

  it('carries an earlier summary into the next one', () => {
    const items = [
      item(9, { kind: 'compaction', summary: 'what happened before', coversThroughSeq: 4 }),
      ...conversation(2),
    ];

    // A compaction item loads first but carries a later seq than the tail it
    // precedes, so it has to be included on kind rather than on position.
    const text = renderForSummary(items, 3);

    expect(text).toContain('Earlier summary:\nwhat happened before');
    expect(text).toContain('Student: question 1');
  });

  it('caps a long tool result', () => {
    const items = [
      item(1, {
        kind: 'tool_result',
        toolCallId: 'c1',
        toolName: 'browse',
        content: 'x'.repeat(20_000),
      }),
    ];

    const text = renderForSummary(items, 2);

    expect(text).toContain('characters truncated');
    expect(text.length).toBeLessThan(3_000);
  });
});

describe('compactTranscript', () => {
  it('summarises the older turns and leaves the kept tail verbatim', async () => {
    const store = new InMemoryTranscriptStore();
    const items = await storedConversation(store, 3);
    const chat = chatReturning('  the story so far  ');

    const compacted = await compactTranscript(depsWith(chat, store), {
      agentId: 'agent-1',
      userId: 'u1',
      items,
      budget: budgetKeeping(1),
    });

    const [request, ctx] = chat.mock.calls[0] as unknown as [
      { messages: { role: string; content: string }[]; tools?: unknown; effort?: string },
      { userId: string; agentId: string },
    ];
    // No tools: the summariser reads a conversation, it does not act in one.
    expect(request.tools).toBeUndefined();
    expect(request.effort).toBe('medium');
    expect(request.messages[0]).toEqual({ role: 'system', content: COMPACTION.body });
    expect(request.messages[1]?.content).toContain('Student: q1');
    expect(ctx).toMatchObject({ userId: 'u1', agentId: 'agent-1' });

    // Users sit at seqs 1,3,5; keeping the last turn cuts at 5, so the summary
    // covers everything through 4.
    expect(compacted?.[0]?.payload).toEqual({
      kind: 'compaction',
      summary: 'the story so far',
      coversThroughSeq: 4,
    });
    expect(compacted?.slice(1).map((i) => i.seq)).toEqual([5, 6]);
  });

  it('skips rather than fails when the summariser throws', async () => {
    const store = new InMemoryTranscriptStore();
    const items = await storedConversation(store, 3);
    const before = await store.count('agent-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chat = vi.fn(async () => {
      throw new Error('the model is down');
    });

    const compacted = await compactTranscript(depsWith(chat, store), {
      agentId: 'agent-1',
      userId: 'u1',
      items,
      budget: budgetKeeping(1),
    });

    expect(compacted).toBeUndefined();
    expect(await store.count('agent-1')).toBe(before);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips rather than fails when the summariser returns nothing', async () => {
    const store = new InMemoryTranscriptStore();
    const items = await storedConversation(store, 3);
    const before = await store.count('agent-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const compacted = await compactTranscript(depsWith(chatReturning('   '), store), {
      agentId: 'agent-1',
      userId: 'u1',
      items,
      budget: budgetKeeping(1),
    });

    // An empty summary stored as a handoff would tell the next turn the chat
    // so far amounted to nothing.
    expect(compacted).toBeUndefined();
    expect(await store.count('agent-1')).toBe(before);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('gives the second summariser call the first summary to build on', async () => {
    const store = new InMemoryTranscriptStore();
    const first = await storedConversation(store, 3);
    const chat = chatReturning('first summary');
    await compactTranscript(depsWith(chat, store), {
      agentId: 'agent-1',
      userId: 'u1',
      items: first,
      budget: budgetKeeping(1),
    });

    await store.append([
      { agentId: 'agent-1', turnId: 'turn-4', payload: { kind: 'user', content: 'q4' } },
      { agentId: 'agent-1', turnId: 'turn-4', payload: { kind: 'assistant', content: 'a4' } },
    ]);
    await compactTranscript(depsWith(chat, store), {
      agentId: 'agent-1',
      userId: 'u1',
      items: await store.load('agent-1'),
      budget: budgetKeeping(1),
    });

    const second = chat.mock.calls[1] as unknown as [{ messages: { content: string }[] }];
    expect(second[0].messages[1]?.content).toContain('Earlier summary:\nfirst summary');
  });
});
