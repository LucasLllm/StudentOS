import { eq } from 'drizzle-orm';
import type { Database } from '@contexto/db';
import { agents } from '@contexto/db';
import type { AgentPlan, PlanStore } from './types.js';

/** Postgres-backed plan storage. One nullable jsonb column on the agent row. */
export class PostgresPlanStore implements PlanStore {
  constructor(private readonly db: Database) {}

  async read(agentId: string): Promise<AgentPlan | null> {
    const [row] = await this.db
      .select({ plan: agents.plan })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    return row?.plan ? (row.plan as AgentPlan) : null;
  }

  async save(agentId: string, plan: AgentPlan): Promise<void> {
    await this.db.update(agents).set({ plan }).where(eq(agents.id, agentId));
  }
}

/**
 * A plan store that lives only in process memory.
 *
 * Tests and evals need the same read/save semantics as Postgres without a
 * database to set up or tear down.
 */
export class InMemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, AgentPlan>();

  async read(agentId: string): Promise<AgentPlan | null> {
    return this.plans.get(agentId) ?? null;
  }

  async save(agentId: string, plan: AgentPlan): Promise<void> {
    this.plans.set(agentId, plan);
  }
}
