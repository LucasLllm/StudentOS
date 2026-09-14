import { describe, expect, it } from 'vitest';
import { updatePlan } from './plan.js';
import { ToolRegistry } from './registry.js';
import { buildToolRegistry } from './builtin.js';
import { InMemoryPlanStore } from '../plan/store.js';
import type { ToolContext } from './types.js';

/**
 * The tool half of the plan feature.
 *
 * validatePlan and the store already have their own tests; this one is about
 * the wiring between them -- that a call the model actually makes lands in
 * the store under the right turn seq, and that a malformed plan is rejected
 * with the sentence the model can act on rather than silently stored.
 */

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { userId: 'u1', agentId: 'a1', ...overrides };
}

describe('plan_update', () => {
  it('saves the plan under the current turn seq', async () => {
    const plans = new InMemoryPlanStore();
    const result = await updatePlan.execute(
      {
        plan: [
          { step: 'Find the syllabus', status: 'in_progress' },
          { step: 'Draft the outline', status: 'pending' },
        ],
      },
      context({ plans, turnSeq: 7 }),
    );

    expect(result).toEqual({
      saved: true,
      plan: [
        { step: 'Find the syllabus', status: 'in_progress' },
        { step: 'Draft the outline', status: 'pending' },
      ],
    });

    const stored = await plans.read('a1');
    expect(stored).toEqual({
      steps: [
        { step: 'Find the syllabus', status: 'in_progress' },
        { step: 'Draft the outline', status: 'pending' },
      ],
      updatedAtSeq: 7,
    });
  });

  it('reports plans are unavailable rather than throwing', async () => {
    const result = await updatePlan.execute(
      {
        plan: [
          { step: 'Find the syllabus', status: 'in_progress' },
          { step: 'Draft the outline', status: 'pending' },
        ],
      },
      context(),
    );

    expect(result).toEqual({ error: 'Plans are not available here.' });
  });

  it('rejects two in-progress steps with the sentence the model can act on', async () => {
    const plans = new InMemoryPlanStore();
    const result = await updatePlan.execute(
      {
        plan: [
          { step: 'Find the syllabus', status: 'in_progress' },
          { step: 'Draft the outline', status: 'in_progress' },
        ],
      },
      context({ plans, turnSeq: 1 }),
    );

    expect(result).toEqual({
      error: 'Exactly one step is in progress at a time, unless every step is completed.',
    });
    expect(await plans.read('a1')).toBeNull();
  });

  it('rejects six steps at the schema, before validatePlan ever runs', async () => {
    const registry = new ToolRegistry().register(updatePlan);
    const plan = Array.from({ length: 6 }, (_, i) => ({
      step: `Step ${i}`,
      status: 'pending' as const,
    }));

    const result = (await registry.execute(
      'plan_update',
      JSON.stringify({ plan }),
      context({ plans: new InMemoryPlanStore() }),
    )) as { error: string };

    expect(result.error).toMatch(/^Invalid arguments/);
  });

  it('is registered for a student with no scopes at all', () => {
    const ids = buildToolRegistry(null).ids();
    expect(ids).toContain('plan_update');
  });
});
