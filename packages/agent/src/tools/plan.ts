import { z } from 'zod';
import type { Tool } from './types.js';
import type { PlanStep } from '../plan/types.js';
import { validatePlan } from '../plan/render.js';

/**
 * The model's own hand on the plan.
 *
 * The plan only stays useful if the model that owns the task keeps it
 * current -- nothing else knows when a step actually finished or the goal
 * changed. This is the one write path into plan storage, so every write goes
 * through validatePlan first: a malformed plan is rejected back to the model
 * with a sentence it can act on, rather than landing in storage and getting
 * recited as fact on the next turn.
 */

const inputSchema = z.object({
  explanation: z.string().max(300).optional().describe('One line on why the plan changed'),
  plan: z
    .array(
      z.object({
        step: z.string().max(200).describe('One milestone, under ten words'),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    )
    .min(2)
    .max(5),
});

export const updatePlan: Tool<
  z.infer<typeof inputSchema>,
  { saved: true; plan: PlanStep[] } | { error: string }
> = {
  id: 'plan_update',
  description:
    'Keep a short plan for a task that takes more than one step or more than one turn: two ' +
    'to five milestones, each pending, in_progress or completed. Exactly one step is ' +
    'in_progress at a time. Call this when you start such a task, whenever a step finishes, ' +
    'and when the goal changes. Never move a step from pending straight to completed. Not ' +
    'for a question you can answer in one go.',
  inputSchema,
  async execute(input, ctx) {
    if (!ctx.plans) {
      return { error: 'Plans are not available here.' };
    }

    const problem = validatePlan(input.plan);
    if (problem) {
      return { error: problem };
    }

    await ctx.plans.save(ctx.agentId, { steps: input.plan, updatedAtSeq: ctx.turnSeq ?? 0 });
    return { saved: true, plan: input.plan };
  },
};
