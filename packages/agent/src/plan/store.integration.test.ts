import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { createDatabase, agents, user, type Database } from '@contexto/db';
import { PostgresPlanStore } from './store.js';
import type { AgentPlan } from './types.js';

/**
 * Against a real database, since the in-memory store's semantics are simple
 * enough to trust by inspection but the jsonb round-trip through Postgres is
 * the part actually worth proving.
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://studentos:studentos@localhost:5432/contexto_test';

const plan = (overrides: Partial<AgentPlan> = {}): AgentPlan => ({
  steps: [
    { step: 'find sources', status: 'completed' },
    { step: 'write draft', status: 'in_progress' },
  ],
  updatedAtSeq: 1,
  ...overrides,
});

describe('PostgresPlanStore', () => {
  let db: Database;
  let store: PostgresPlanStore;
  let agentId: string;

  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL, maxConnections: 4 });
    await migrate(db, {
      migrationsFolder: new URL('../../../db/migrations', import.meta.url).pathname,
    });
    store = new PostgresPlanStore(db);
  });

  beforeEach(async () => {
    const userId = `plan-test-${randomUUID()}`;
    await db.insert(user).values({
      id: userId,
      name: 'Plan Test',
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    const [agent] = await db
      .insert(agents)
      .values({ userId, name: 'plan-test', purpose: 'testing' })
      .returning();
    agentId = agent!.id;
  });

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "user" CASCADE`);
  });

  it('returns null before a plan has ever been saved', async () => {
    expect(await store.read(agentId)).toBeNull();
  });

  it('round-trips a saved plan', async () => {
    await store.save(agentId, plan());
    expect(await store.read(agentId)).toEqual(plan());
  });

  it('overwrites the previous plan on a second save', async () => {
    await store.save(agentId, plan());
    const revised = plan({
      steps: [
        { step: 'find sources', status: 'completed' },
        { step: 'write draft', status: 'completed' },
      ],
      updatedAtSeq: 5,
    });
    await store.save(agentId, revised);
    expect(await store.read(agentId)).toEqual(revised);
  });
});
