import { describe, expect, it } from 'vitest';
import { PROBLEM_SOLVING } from './documents.js';

/**
 * The one-question rule, reconciled with responding.md.
 *
 * The document used to ask for the question, then separately ask what the
 * student has tried -- two questions where responding.md's "one, not three"
 * rule allows one. Now it asks for both together, in the same message.
 */
describe('asking for the question and the attempt', () => {
  it('asks for both together, in one message, rather than as two questions', () => {
    expect(PROBLEM_SOLVING.body).toMatch(/together, in one message/i);
    expect(PROBLEM_SOLVING.body).toMatch(
      /question and (their|the) attempt|attempt (and|with) the question/i,
    );
  });
});
