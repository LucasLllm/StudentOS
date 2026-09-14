import { eq } from 'drizzle-orm';
import { agentMessages } from '@contexto/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { PostgresPlanStore, PostgresTranscriptStore } from '@contexto/agent';
import { runTurnForAgent } from './agent-turn.js';
import { resetTurns, turnActivity, turnRunning } from './turns-in-flight.js';
import { createAgent, createUser, reset, testDb } from './test-support/harness.js';
import type { AppContext } from './context.js';

/**
 * The seam between a running turn and what the conversation is told about it.
 *
 * The bug this exists for is the one the agent package has already been bitten
 * by: an input accepted at the bottom of the stack that nothing at the top ever
 * passes. `runAgentTurn` reports every step it takes and has tests proving it;
 * none of that reaches a student unless this file hands it somewhere the poll
 * can read. Tested from inside the turn, because the moment the seam describes
 * only exists while the turn is running -- afterwards it is deliberately gone.
 */

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/**
 * Enough context to run a turn. Everything a turn touches that is not the
 * database is stubbed; the database is real, because both messages the turn
 * writes are rows and the harness already has one.
 */
async function contextWith(
  chat: (request: { tools?: unknown }) => Promise<unknown>,
): Promise<AppContext> {
  return {
    db: await testDb(),
    llm: { chat },
    memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
    skills: { list: async () => [] },
    transcript: new PostgresTranscriptStore(await testDb()),
    plans: new PostgresPlanStore(await testDb()),
    auth: {},
    youtube: {},
    youtubeTranscripts: {},
  } as unknown as AppContext;
}

beforeEach(async () => {
  await reset();
  resetTurns();
});

/**
 * Chats that were had before the transcript table existed.
 *
 * Their words are in `agentMessages` and nowhere else, so the first turn after
 * the upgrade has to seed the transcript from them or the model meets a
 * stranger it has been talking to for a week.
 */
describe('a chat from before the transcript existed', () => {
  it('starts from its last messages, once', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);
    const db = await testDb();
    await db.insert(agentMessages).values([
      { agentId: agent.id, role: 'user', content: 'earlier question' },
      { agentId: agent.id, role: 'assistant', content: 'earlier answer' },
    ]);
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const ctx = await contextWith(async (request) => {
      requests.push(request as never);
      return { content: 'ok', toolCalls: [], usage, finishReason: 'stop' as const };
    });
    await runTurnForAgent(ctx, { userId: alice.id, agent, content: 'now' });
    expect(requests[0]!.messages.map((m) => m.content)).toEqual(
      expect.arrayContaining(['earlier question', 'earlier answer']),
    );
    await runTurnForAgent(ctx, { userId: alice.id, agent, content: 'again' });
    const items = await ctx.transcript.load(agent.id);
    expect(
      items.filter((i) => i.payload.kind === 'user' && i.payload.content === 'earlier question'),
    ).toHaveLength(1);
  });
});

describe('reporting what a turn is doing', () => {
  it('says it is thinking while it waits on the model', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    let seen: unknown;
    const ctx = await contextWith(async () => {
      seen = turnActivity(agent.id);
      return { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
    });

    await runTurnForAgent(ctx, { userId: alice.id, agent, content: 'hello' });

    expect(seen).toEqual({ kind: 'thinking' });
  });

  it('files it under the conversation that asked, and no other', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);
    const other = await createAgent(alice.id);

    let seen: unknown = 'unset';
    const ctx = await contextWith(async () => {
      seen = turnActivity(other.id);
      return { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
    });

    await runTurnForAgent(ctx, { userId: alice.id, agent, content: 'hello' });

    expect(seen).toBeUndefined();
  });

  it('has nothing left to say once the turn is over', async () => {
    // A finished answer with a line under it still claiming to be thinking is
    // worse than no line at all: it says the app has lost track.
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const ctx = await contextWith(async () => ({
      content: 'done',
      toolCalls: [],
      usage,
      finishReason: 'stop' as const,
    }));

    await runTurnForAgent(ctx, { userId: alice.id, agent, content: 'hello' });

    expect(turnRunning(agent.id)).toBe(false);
    expect(turnActivity(agent.id)).toBeUndefined();
  });

  it('stops reporting when the turn throws, rather than freezing on a step', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const ctx = await contextWith(async () => {
      throw new Error('the model fell over');
    });

    await expect(
      runTurnForAgent(ctx, { userId: alice.id, agent, content: 'hello' }),
    ).rejects.toThrow();
    expect(turnActivity(agent.id)).toBeUndefined();
  });
});

/**
 * What a turn read stays with its reply.
 *
 * The live list in the registry is gone the moment the turn ends. The row is
 * what the conversation shows above the answer from then on, so it has to
 * hold the same names.
 */
describe('what a turn read', () => {
  /**
   * Reads the named skill, then replies.
   *
   * Decided by the request rather than by counting calls: a chat's first
   * message is also being named, by the same model, and that call has no
   * tools to offer. Answering it with a tool call would hand the skill to
   * the title and a bare "done" to the turn.
   */
  function readingThenReplying(name: string) {
    let read = false;
    return async (request: { tools?: unknown }) => {
      if (!request.tools || read) {
        return { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
      }
      read = true;
      return {
        content: '',
        toolCalls: [{ id: 'c1', name: 'skill_load', arguments: JSON.stringify({ name }) }],
        usage,
        finishReason: 'tool_calls' as const,
      };
    };
  }

  it('keeps the skills it read on the reply', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);
    const ctx = await contextWith(readingThenReplying('browser'));

    const { assistantMessage } = await runTurnForAgent(ctx, {
      userId: alice.id,
      agent,
      content: 'open my portal',
    });

    expect(assistantMessage.skillsRead).toEqual(['browser']);
    const [row] = await ctx.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.id, assistantMessage.id));
    expect(row?.skillsRead).toEqual(['browser']);
  });

  it('says a reply that read nothing read nothing', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);
    const ctx = await contextWith(async () => ({
      content: 'done',
      toolCalls: [],
      usage,
      finishReason: 'stop' as const,
    }));

    const { assistantMessage } = await runTurnForAgent(ctx, {
      userId: alice.id,
      agent,
      content: 'hello',
    });

    expect(assistantMessage.skillsRead).toEqual([]);
  });
});
