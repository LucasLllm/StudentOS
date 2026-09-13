import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, agents, user, type Database } from '@contexto/db';
import { PostgresTranscriptStore } from './store.js';

/**
 * The same four cases as in-memory.test.ts, plus cascade deletion, against a
 * real database.
 *
 * The in-memory store is a faithful copy of this one's semantics, not the
 * other way around -- so this file is what actually proves load/append/count
 * behave as documented, including the SQL that in-memory has no equivalent
 * for (the FK cascade on agent deletion).
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://studentos:studentos@localhost:5432/contexto_test';

const userContent = (content: string) => ({ kind: 'user' as const, content });

describe('PostgresTranscriptStore', () => {
  let db: Database;
  let store: PostgresTranscriptStore;
  let agentId: string;

  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL, maxConnections: 4 });
    await migrate(db, {
      migrationsFolder: new URL('../../../db/migrations', import.meta.url).pathname,
    });
    store = new PostgresTranscriptStore(db);
  });

  beforeEach(async () => {
    const userId = `transcript-test-${randomUUID()}`;
    await db.insert(user).values({
      id: userId,
      name: 'Transcript Test',
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    const [agent] = await db
      .insert(agents)
      .values({ userId, name: 'transcript-test', purpose: 'testing' })
      .returning();
    agentId = agent!.id;
  });

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "user" CASCADE`);
  });

  it('returns items in the order they were appended, with rising seq', async () => {
    const t1 = randomUUID();
    await store.append([
      { agentId, turnId: t1, payload: userContent('one') },
      { agentId, turnId: t1, payload: { kind: 'assistant', content: 'two' } },
    ]);
    const items = await store.load(agentId);
    expect(items.map((i) => i.payload.kind)).toEqual(['user', 'assistant']);
    expect(items[1]!.seq).toBeGreaterThan(items[0]!.seq);
    expect(await store.count(agentId)).toBe(2);
  });

  it('keeps agents apart', async () => {
    await store.append([{ agentId, turnId: randomUUID(), payload: userContent('mine') }]);
    expect(await store.load(randomUUID())).toEqual([]);
  });

  it('loads from the latest compaction: the summary first, then what it does not cover', async () => {
    const t1 = randomUUID();
    const [u1, , u2] = await store.append([
      { agentId, turnId: t1, payload: userContent('old') },
      { agentId, turnId: t1, payload: { kind: 'assistant', content: 'old reply' } },
      { agentId, turnId: randomUUID(), payload: userContent('kept') },
    ]);
    await store.append([
      {
        agentId,
        turnId: randomUUID(),
        payload: { kind: 'compaction', summary: 'S', coversThroughSeq: u2!.seq - 1 },
      },
    ]);
    const items = await store.load(agentId);
    expect(items.map((i) => i.payload.kind)).toEqual(['compaction', 'user']);
    expect(items[1]!.seq).toBe(u2!.seq);
    expect(items[0]!.seq).toBeGreaterThan(u1!.seq);
  });

  it('records a token estimate on every item', async () => {
    const [item] = await store.append([
      { agentId, turnId: randomUUID(), payload: userContent('x'.repeat(400)) },
    ]);
    expect(item!.tokenEstimate).toBeGreaterThanOrEqual(100);
  });

  it('deleting the agent deletes its transcript', async () => {
    await store.append([{ agentId, turnId: randomUUID(), payload: userContent('gone') }]);
    await db.delete(agents).where(eq(agents.id, agentId));
    expect(await store.count(agentId)).toBe(0);
  });

  it('appending nothing stores nothing and returns an empty list', async () => {
    await store.append([{ agentId, turnId: randomUUID(), payload: userContent('one') }]);
    expect(await store.append([])).toEqual([]);
    expect(await store.count(agentId)).toBe(1);
  });
});
