import { describe, expect, it } from 'vitest';
import { PLAN_STALE_AFTER_TURNS, renderPlan, validatePlan } from './render.js';
import type { PlanStep } from './types.js';

const step = (step: string, status: PlanStep['status']): PlanStep => ({ step, status });

describe('validatePlan', () => {
  it('rejects a single step', () => {
    expect(validatePlan([step('one', 'in_progress')])).not.toBeNull();
  });

  it('rejects six steps', () => {
    const steps = Array.from({ length: 6 }, (_, i) => step(`step ${i}`, 'pending'));
    steps[0] = step('step 0', 'in_progress');
    expect(validatePlan(steps)).not.toBeNull();
  });

  it('rejects two steps in progress at once', () => {
    expect(validatePlan([step('one', 'in_progress'), step('two', 'in_progress')])).not.toBeNull();
  });

  it('accepts every step completed, with none in progress', () => {
    expect(validatePlan([step('one', 'completed'), step('two', 'completed')])).toBeNull();
  });

  it('accepts a valid plan with exactly one step in progress', () => {
    expect(
      validatePlan([
        step('one', 'completed'),
        step('two', 'in_progress'),
        step('three', 'pending'),
      ]),
    ).toBeNull();
  });

  it('rejects an empty step', () => {
    expect(validatePlan([step('', 'in_progress'), step('two', 'pending')])).not.toBeNull();
  });

  it('rejects a step over 200 characters', () => {
    expect(
      validatePlan([step('x'.repeat(201), 'in_progress'), step('two', 'pending')]),
    ).not.toBeNull();
  });
});

describe('renderPlan', () => {
  it('renders numbered labels in order', () => {
    const plan = {
      steps: [
        step('find sources', 'completed'),
        step('write draft', 'in_progress'),
        step('revise', 'pending'),
      ],
      updatedAtSeq: 1,
    };
    const rendered = renderPlan(plan, 0);
    expect(rendered).toBe(
      'Your plan for this conversation (keep it current with plan_update):\n' +
        '1. [done] find sources\n' +
        '2. [in progress] write draft\n' +
        '3. [pending] revise',
    );
  });

  it('does not nudge when turnsSince is below the stale threshold', () => {
    const plan = { steps: [step('one', 'in_progress'), step('two', 'pending')], updatedAtSeq: 1 };
    const rendered = renderPlan(plan, PLAN_STALE_AFTER_TURNS - 1);
    expect(rendered).not.toContain('has not been updated');
  });

  it('does not nudge when no step is in progress, even if stale', () => {
    const plan = { steps: [step('one', 'completed'), step('two', 'completed')], updatedAtSeq: 1 };
    const rendered = renderPlan(plan, PLAN_STALE_AFTER_TURNS + 5);
    expect(rendered).not.toContain('has not been updated');
  });

  it('nudges when a step is in progress and turnsSince reaches the threshold', () => {
    const plan = { steps: [step('one', 'in_progress'), step('two', 'pending')], updatedAtSeq: 1 };
    const rendered = renderPlan(plan, PLAN_STALE_AFTER_TURNS);
    expect(rendered).toContain(
      'This plan has not been updated for a few turns. If a step is done or the goal has ' +
        'changed, update it; if the plan no longer applies, ignore this.',
    );
  });
});
