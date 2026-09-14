import { describe, expect, it } from 'vitest';
import { WORKING } from './documents.js';

const body = WORKING.body;

/**
 * How the agent is told to work through a task, on every turn.
 *
 * Distinct from responding.md, which covers how it talks. This is about
 * whether it keeps going, when it stops to ask, how much it looks up before
 * answering, how it batches independent tool calls, what a plan is for, and
 * what a handoff summary and a cleared tool result mean when a turn sees one.
 */
describe('keeping going', () => {
  it('says to keep going until the question is actually answered', () => {
    expect(body).toMatch(/keep going until the student's question is actually answered/i);
  });

  it('refuses a partial answer, an outline, or a promise for later', () => {
    expect(body).toMatch(/do not stop at a partial answer/i);
  });

  it('says not to wrap up early, because the chat has no length limit', () => {
    expect(body).toMatch(/no need to wrap up early/i);
  });
});

describe('when to ask', () => {
  it('holds it to one question, asked once', () => {
    expect(body).toMatch(/ask, once, at the end/i);
  });

  it('tells it to make the reasonable assumption otherwise', () => {
    expect(body).toMatch(/make the reasonable assumption/i);
  });
});

describe('how much to look up', () => {
  it('caps lookups at two before answering', () => {
    expect(body).toMatch(/at most two lookups/i);
  });

  it('says independent lookups can go together in one step', () => {
    expect(body).toMatch(/make them together in one step/i);
  });
});

describe('the plan', () => {
  it('names plan_update for work that takes several steps', () => {
    expect(body).toContain('plan_update');
  });
});

describe('the handoff summary and cleared results', () => {
  it('mentions the handoff summary', () => {
    expect(body).toMatch(/handoff summary/i);
  });

  it('mentions that older tool results may have been cleared', () => {
    expect(body).toMatch(/tool results may have been cleared/i);
  });
});
