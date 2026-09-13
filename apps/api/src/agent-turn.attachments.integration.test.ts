import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PostgresTranscriptStore, Vault } from '@contexto/agent';
import { runTurnForAgent } from './agent-turn.js';
import { resetTurns } from './turns-in-flight.js';
import { createAgent, createUser, reset, testDb } from './test-support/harness.js';
import type { AppContext } from './context.js';

/**
 * A file stays attached to the conversation, not to one message.
 *
 * The bug this exists for was reported the way a student would meet it: attach
 * a photograph, ask what it is, get an answer -- then ask a follow-up and find
 * the agent has never seen it. The transcription was in the vault the whole
 * time and out of reach again, because only the incoming message's own
 * attachments were being read.
 *
 * Written against the real database because the fix is a query over stored
 * messages: a stub of that query would pass whatever it was told to.
 */

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/**
 * Every user message the TURN gave the model, in order.
 *
 * Turns are not the only model calls a first message makes any more -- naming
 * the chat is another, running beside it -- so they are told apart by the
 * turn context wrapper rather than by counting. Counting was what broke when
 * naming arrived, and would break again on the next thing that runs alongside.
 *
 * The last user message, not the first: a turn now replays the whole
 * conversation, and every earlier question is a user message too.
 */
let seen: string[];

async function contextWith(vaultRoot: string): Promise<AppContext> {
  seen = [];
  return {
    db: await testDb(),
    llm: {
      chat: async ({ messages }: { messages: { role: string; content: string }[] }) => {
        const user = messages.findLast((m) => m.role === 'user');
        if (user?.content.includes('<turn_context>')) seen.push(user.content);
        return { content: 'ok', toolCalls: [], usage, finishReason: 'stop' as const };
      },
    },
    memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
    skills: { list: async () => [] },
    transcript: new PostgresTranscriptStore(await testDb()),
    auth: {},
    youtube: {},
    youtubeTranscripts: {},
    env: { VAULT_ROOT: vaultRoot },
  } as unknown as AppContext;
}

beforeEach(async () => {
  await reset();
  resetTurns();
});

describe('a file attached earlier in the conversation', () => {
  /** A vault holding one read picture, as an upload would have left it. */
  async function vaultWith(userId: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'turn-attach-'));
    const vault = new Vault(root, userId);
    await vault.write({
      name: 'board',
      kind: 'entity',
      source: 'student',
      description: 'Read from a picture the student uploaded: board.png',
      body: '## What is in it\n\nA brass push-fit pneumatic connector, 8mm.',
    });
    return root;
  }

  const photo = [{ name: 'board', filename: 'board.png', image: true }];

  it('is read on the turn it was attached to', async () => {
    const user = await createUser();
    const agent = await createAgent(user.id);
    const ctx = await contextWith(await vaultWith(user.id));

    await runTurnForAgent(ctx, {
      userId: user.id,
      agent,
      content: 'what is this',
      attachments: photo,
    });

    expect(seen[0]).toContain('brass push-fit pneumatic connector');
  });

  it('is still there on the next question, which carries no files of its own', async () => {
    /*
     * The reported bug, exactly. The follow-up sends no attachments -- there
     * is nothing to attach, the student is simply still talking about the
     * photograph they sent a minute ago.
     */
    const user = await createUser();
    const agent = await createAgent(user.id);
    const ctx = await contextWith(await vaultWith(user.id));

    await runTurnForAgent(ctx, {
      userId: user.id,
      agent,
      content: 'what is this',
      attachments: photo,
    });
    await runTurnForAgent(ctx, { userId: user.id, agent, content: 'what size is the thread' });

    expect(seen[1]).toContain('brass push-fit pneumatic connector');
  });

  it('is not carried into a different chat', async () => {
    // Attachments belong to the conversation they were sent to. Another chat
    // of the same student reaches them through the vault or not at all.
    const user = await createUser();
    const withPhoto = await createAgent(user.id, 'Has the photo');
    const other = await createAgent(user.id, 'Does not');
    const ctx = await contextWith(await vaultWith(user.id));

    await runTurnForAgent(ctx, {
      userId: user.id,
      agent: withPhoto,
      content: 'what is this',
      attachments: photo,
    });
    await runTurnForAgent(ctx, { userId: user.id, agent: other, content: 'unrelated question' });

    expect(seen[1]).not.toContain('brass push-fit pneumatic connector');
  });

  it('says nothing about attachments in a conversation that has had none', async () => {
    const user = await createUser();
    const agent = await createAgent(user.id);
    const ctx = await contextWith(await vaultWith(user.id));

    await runTurnForAgent(ctx, { userId: user.id, agent, content: 'just a question' });

    expect(seen[0]).not.toContain('attached to this message');
  });
});
