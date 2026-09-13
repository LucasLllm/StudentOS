import { describe, expect, it } from 'vitest';
import { InMemoryTranscriptStore } from './in-memory.js';

const user = (content: string) => ({ kind: 'user' as const, content });

describe('InMemoryTranscriptStore', () => {
  it('returns items in the order they were appended, with rising seq', async () => {
    const store = new InMemoryTranscriptStore();
    await store.append([
      { agentId: 'a', turnId: 't1', payload: user('one') },
      { agentId: 'a', turnId: 't1', payload: { kind: 'assistant', content: 'two' } },
    ]);
    const items = await store.load('a');
    expect(items.map((i) => i.payload.kind)).toEqual(['user', 'assistant']);
    expect(items[1]!.seq).toBeGreaterThan(items[0]!.seq);
    expect(await store.count('a')).toBe(2);
  });

  it('keeps agents apart', async () => {
    const store = new InMemoryTranscriptStore();
    await store.append([{ agentId: 'a', turnId: 't', payload: user('mine') }]);
    expect(await store.load('b')).toEqual([]);
  });

  it('loads from the latest compaction: the summary first, then what it does not cover', async () => {
    const store = new InMemoryTranscriptStore();
    const [u1, , u2] = await store.append([
      { agentId: 'a', turnId: 't1', payload: user('old') },
      { agentId: 'a', turnId: 't1', payload: { kind: 'assistant', content: 'old reply' } },
      { agentId: 'a', turnId: 't2', payload: user('kept') },
    ]);
    await store.append([
      {
        agentId: 'a',
        turnId: 't3',
        payload: { kind: 'compaction', summary: 'S', coversThroughSeq: u2!.seq - 1 },
      },
    ]);
    const items = await store.load('a');
    expect(items.map((i) => i.payload.kind)).toEqual(['compaction', 'user']);
    expect(items[1]!.seq).toBe(u2!.seq);
    expect(items[0]!.seq).toBeGreaterThan(u1!.seq);
  });

  it('records a token estimate on every item', async () => {
    const store = new InMemoryTranscriptStore();
    const [item] = await store.append([
      { agentId: 'a', turnId: 't', payload: user('x'.repeat(400)) },
    ]);
    expect(item!.tokenEstimate).toBeGreaterThanOrEqual(100);
  });

  it('appending nothing stores nothing and returns an empty list', async () => {
    const store = new InMemoryTranscriptStore();
    await store.append([{ agentId: 'a', turnId: 't', payload: user('one') }]);
    expect(await store.append([])).toEqual([]);
    expect(await store.count('a')).toBe(1);
  });
});
