import { describe, expect, it } from 'vitest';
import type { ProjectRef } from '@contexto/agent';
import { MAX_GATHERED, gatherContext, type Candidate, type Searchers } from './gather.js';

/**
 * The sweep that fills a new project.
 *
 * What must hold: it stays two calls and a bounded handful of items however
 * much it finds; a model that answers badly adds nothing rather than anything;
 * and the project is always marked gathered, or the page says "Gathering"
 * for ever.
 */

function replies(...contents: (string | Error)[]) {
  let call = 0;
  return {
    calls: () => call,
    llm: {
      chat: async () => {
        const next = contents[call++];
        if (next instanceof Error) throw next;
        return { content: next ?? '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    },
  };
}

function candidates(count: number, where: Candidate['where'] = 'vault'): Candidate[] {
  return Array.from({ length: count }, (_, i) => ({
    ref: { note: `note-${i}` },
    title: `Note ${i}`,
    where,
    snippet: 'snippet',
  }));
}

function searchers(found: Candidate[]): Searchers {
  return { vault: async () => found, mail: async () => [], drive: async () => [] };
}

const input = { userId: 'u1', name: 'CAS proposal', instructions: 'Get it approved.' };

describe('gatherContext', () => {
  it('adds what the model picks, in two calls', async () => {
    const model = replies('{"queries": ["incubator", "cas"]}', '{"pick": [2, 1]}');
    const added: ProjectRef[] = [];
    let done = false;

    const count = await gatherContext(
      {
        llm: model.llm as never,
        searchers: searchers(candidates(3)),
        add: async (ref) => {
          added.push(ref);
          return { name: 'x', added: true };
        },
        done: async () => {
          done = true;
        },
      },
      input,
    );

    expect(count).toBe(2);
    expect(added).toEqual([{ note: 'note-1' }, { note: 'note-0' }]);
    expect(model.calls()).toBe(2);
    expect(done).toBe(true);
  });

  it(`never adds more than ${MAX_GATHERED}`, async () => {
    const all = Array.from({ length: 20 }, (_, i) => i + 1);
    const model = replies('{"queries": ["a b"]}', JSON.stringify({ pick: all }));
    const added: ProjectRef[] = [];
    await gatherContext(
      {
        llm: model.llm as never,
        searchers: searchers(candidates(20)),
        add: async (ref) => {
          added.push(ref);
          return { name: 'x', added: true };
        },
        done: async () => {},
      },
      input,
    );
    expect(added).toHaveLength(MAX_GATHERED);
  });

  it('adds nothing when the model answers with something that is not the JSON asked for', async () => {
    const model = replies('{"queries": ["a b"]}', 'Sure! I would pick the first two.');
    const added: ProjectRef[] = [];
    await gatherContext(
      {
        llm: model.llm as never,
        searchers: searchers(candidates(3)),
        add: async (ref) => {
          added.push(ref);
          return { name: 'x', added: true };
        },
        done: async () => {},
      },
      input,
    );
    expect(added).toEqual([]);
  });

  it('marks the project gathered even when the model is down', async () => {
    const model = replies(new Error('down'));
    let done = false;
    const count = await gatherContext(
      {
        llm: model.llm as never,
        searchers: searchers(candidates(3)),
        add: async () => undefined,
        done: async () => {
          done = true;
        },
      },
      input,
    );
    expect(count).toBe(0);
    expect(done).toBe(true);
  });

  it('asks about one candidate once, however many searches found it', async () => {
    const model = replies('{"queries": ["a b", "c d", "e f"]}', '{"pick": [1, 2]}');
    const added: ProjectRef[] = [];
    await gatherContext(
      {
        llm: model.llm as never,
        searchers: searchers(candidates(1)),
        add: async (ref) => {
          added.push(ref);
          return { name: 'x', added: true };
        },
        done: async () => {},
      },
      input,
    );
    expect(added).toEqual([{ note: 'note-0' }]);
  });
});
