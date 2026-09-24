import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostgresPlanStore, PostgresTranscriptStore, projectVault } from '@contexto/agent';
import { agents, projectSources, projects } from '@contexto/db';
import { runTurnForAgent } from './agent-turn.js';
import { resetTurns } from './turns-in-flight.js';
import { createUser, reset, testDb } from './test-support/harness.js';
import type { AppContext } from './context.js';

/**
 * A chat inside a project, turn by turn.
 *
 * The property this is for is the one that makes projects affordable: the
 * system prompt of a project chat is the same bytes on every turn, however the
 * project's context changes underneath it, so the provider serves it from
 * cache. What changes is told in the turn context instead.
 */

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
let turns: { role: string; content: string }[][];

async function contextWith(vaultRoot: string): Promise<AppContext> {
  turns = [];
  return {
    db: await testDb(),
    llm: {
      chat: async ({ messages }: { messages: { role: string; content: string }[] }) => {
        const user = messages.findLast((m) => m.role === 'user');
        if (user?.content.includes('<turn_context>')) turns.push(messages);
        return { content: 'ok', toolCalls: [], usage, finishReason: 'stop' as const };
      },
    },
    memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
    skills: { list: async () => [] },
    transcript: new PostgresTranscriptStore(await testDb()),
    plans: new PostgresPlanStore(await testDb()),
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

const system = (turn: number) => turns[turn]?.find((m) => m.role === 'system')?.content ?? '';
const asked = (turn: number) => turns[turn]?.findLast((m) => m.role === 'user')?.content ?? '';

async function projectWithChat(userId: string, root: string) {
  const db = await testDb();
  const [project] = await db
    .insert(projects)
    .values({ userId, name: 'CAS proposal', instructions: 'Get the incubator approved.' })
    .returning();
  const vault = projectVault(root, userId, project!.id);
  await vault.write({
    name: 'budget',
    kind: 'entity',
    source: 'student',
    description: 'budget',
    body: 'The incubator needs four hundred dollars.',
  });
  await db.insert(projectSources).values({
    projectId: project!.id,
    noteName: 'budget',
    noteKind: 'entity',
    owned: true,
    kind: 'text',
    summary: 'The incubator budget',
    tokens: 10,
  });
  const [agent] = await db
    .insert(agents)
    .values({ userId, name: 'Chat', projectId: project!.id })
    .returning();
  return { project: project!, agent: agent!, vault };
}

describe('a project chat', () => {
  it('is told its project, whole, on its first turn, and keeps that block', async () => {
    const user = await createUser();
    const root = await mkdtemp(join(tmpdir(), 'turn-project-'));
    const { agent } = await projectWithChat(user.id, root);
    const ctx = await contextWith(root);

    await runTurnForAgent(ctx, { userId: user.id, agent, content: 'how much do we need?' });

    expect(system(0)).toContain('Get the incubator approved.');
    expect(system(0)).toContain('four hundred dollars');

    const db = await testDb();
    const [stored] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(stored?.projectContext).toContain('four hundred dollars');
  });

  it('keeps the same system prompt after something is added, and says what was', async () => {
    const user = await createUser();
    const root = await mkdtemp(join(tmpdir(), 'turn-project-'));
    const { project, agent, vault } = await projectWithChat(user.id, root);
    const ctx = await contextWith(root);
    const db = await testDb();

    await runTurnForAgent(ctx, { userId: user.id, agent, content: 'first' });

    await vault.write({
      name: 'rubric',
      kind: 'entity',
      source: 'student',
      description: 'rubric',
      body: 'Graded on clarity.',
    });
    await db.insert(projectSources).values({
      projectId: project.id,
      noteName: 'rubric',
      noteKind: 'entity',
      owned: true,
      kind: 'text',
      summary: 'How the proposal is graded',
      tokens: 5,
    });

    const [again] = await db.select().from(agents).where(eq(agents.id, agent.id));
    await runTurnForAgent(ctx, { userId: user.id, agent: again!, content: 'second' });

    expect(system(1)).toBe(system(0));
    expect(asked(1)).toContain('rubric (text): How the proposal is graded');
    expect(asked(0)).not.toContain('rubric');
  });

  it('is not told anything about the project in an ordinary chat', async () => {
    const user = await createUser();
    const root = await mkdtemp(join(tmpdir(), 'turn-project-'));
    await projectWithChat(user.id, root);
    const ctx = await contextWith(root);
    const db = await testDb();
    const [ordinary] = await db
      .insert(agents)
      .values({ userId: user.id, name: 'Plain' })
      .returning();

    await runTurnForAgent(ctx, { userId: user.id, agent: ordinary!, content: 'hello' });

    expect(system(0)).not.toContain('four hundred dollars');
    expect(system(0)).not.toContain('CAS proposal');
  });
});
