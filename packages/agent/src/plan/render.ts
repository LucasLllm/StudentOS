import type { AgentPlan, PlanStep } from './types.js';

/**
 * Keeping the plan honest and putting it back in front of the model.
 *
 * A plan the model wrote once and never revisits is worse than no plan: it
 * goes stale and the model recites steps it already finished or abandoned.
 * validatePlan is the gate the plan_update tool runs every write through, so a
 * malformed plan never reaches storage. renderPlan is the other half -- the
 * section appended to every turn's context -- and it nudges the model to
 * revisit the plan itself once enough turns have passed without a write,
 * rather than relying on a separate watchdog.
 */

/**
 * Turns of silence on an in-progress plan before the render nudges the model
 * to check on it.
 *
 * Three turns is long enough that a short multi-message exchange about one
 * step does not trigger a false nudge, short enough that a plan does not sit
 * stale for the rest of a long conversation.
 */
export const PLAN_STALE_AFTER_TURNS = 3;

const MAX_STEP_LENGTH = 200;

const STALE_NUDGE =
  '\nThis plan has not been updated for a few turns. If a step is done or the goal has changed, ' +
  'update it; if the plan no longer applies, ignore this.';

const LABELS: Record<PlanStep['status'], string> = {
  completed: 'done',
  in_progress: 'in progress',
  pending: 'pending',
};

/** null when valid, else one sentence the model can act on. */
export function validatePlan(steps: PlanStep[]): string | null {
  if (steps.length < 2 || steps.length > 5) {
    return 'A plan has two to five steps.';
  }
  if (steps.some((s) => s.step.trim().length === 0 || s.step.length > MAX_STEP_LENGTH)) {
    return 'Each step is a short sentence under 200 characters.';
  }

  const inProgressCount = steps.filter((s) => s.status === 'in_progress').length;
  const allCompleted = steps.every((s) => s.status === 'completed');
  if (inProgressCount !== 1 && !allCompleted) {
    return 'Exactly one step is in progress at a time, unless every step is completed.';
  }

  return null;
}

/** The <turn_context> section; turnsSince = user turns since updatedAtSeq. */
export function renderPlan(plan: AgentPlan, turnsSince: number): string {
  const lines = plan.steps.map((s, i) => `${i + 1}. [${LABELS[s.status]}] ${s.step}`);
  const header = 'Your plan for this conversation (keep it current with plan_update):\n';
  const hasInProgress = plan.steps.some((s) => s.status === 'in_progress');
  const nudge = hasInProgress && turnsSince >= PLAN_STALE_AFTER_TURNS ? STALE_NUDGE : '';

  return header + lines.join('\n') + nudge;
}
