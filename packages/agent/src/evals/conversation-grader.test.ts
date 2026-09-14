import { describe, expect, it } from 'vitest';
import { gradeTurn } from './conversation-grader.js';

/**
 * Tests for the conversation grader.
 *
 * Same argument as memory-grader.test.ts: the instrument decides whether a
 * twenty-turn conversation kept what mattered, and a grader that passes a
 * reply which forgot the fact would report the harness working exactly when
 * it is not. The failure this guards is a lenient grader, not a strict one.
 */

const base = { say: 'what did i tell you earlier?' };

describe('grading a turn that names facts', () => {
  it('passes when every expected term is present', () => {
    const result = gradeTurn(
      { ...base, expect: ['Okonkwo', '14 May'] },
      'Ms Okonkwo takes you for chemistry and the paper is on 14 May.',
    );
    expect(result.passed).toBe(true);
  });

  it('fails when one expected term is missing, and names it', () => {
    const result = gradeTurn(
      { ...base, expect: ['Okonkwo', '14 May'] },
      'Ms Okonkwo takes you for chemistry.',
    );
    expect(result.passed).toBe(false);
    expect(result.why).toContain('14 May');
  });

  it('passes when any one of the alternatives is present', () => {
    // The goal case cannot know which step the agent reached, only that it
    // named a step that is still to come rather than one already done.
    const turn = { ...base, expectAny: ['draft', 'intro', 'source'] };
    expect(gradeTurn(turn, 'Next is the source list.').passed).toBe(true);
    expect(gradeTurn(turn, 'Next up: the draft.').passed).toBe(true);
  });

  it('fails when none of the alternatives is present', () => {
    const result = gradeTurn(
      { ...base, expectAny: ['draft', 'intro', 'source'] },
      'We finished the outline, so you are all done.',
    );
    expect(result.passed).toBe(false);
    expect(result.why).toMatch(/draft/);
  });

  it('requires every expect term even when an alternative matched', () => {
    const result = gradeTurn(
      { ...base, expect: ['essay'], expectAny: ['draft', 'source'] },
      'Next is the draft.',
    );
    expect(result.passed).toBe(false);
    expect(result.why).toContain('essay');
  });
});

describe('grading what the reply leads with', () => {
  it('fails when the rejected term opens the reply', () => {
    // Answering the distraction instead of the question is the failure: the
    // student asked where the essay got to and was handed Lima.
    const result = gradeTurn(
      { ...base, expectAny: ['draft'], reject: ['capital', 'Peru'] },
      'The capital of Peru is Lima. Your draft is next.',
    );
    expect(result.passed).toBe(false);
    expect(result.why).toMatch(/capital|Peru/);
  });

  it('allows the rejected term later, once the question is answered', () => {
    const result = gradeTurn(
      { ...base, expectAny: ['draft'], reject: ['capital', 'Peru'] },
      'Next is the draft intro. The capital of Peru was a detour.',
    );
    expect(result.passed).toBe(true);
  });
});

describe('folding the punctuation models actually emit', () => {
  it('treats an em dash as the end of the opening clause', () => {
    // Models write "-- " as an em dash. Without folding it, the whole reply
    // counts as the opening clause and a correct answer scores as a failure.
    const result = gradeTurn(
      { ...base, reject: ['Peru'] },
      'Next is the draft intro — the capital of Peru was a detour.',
    );
    expect(result.passed).toBe(true);
  });

  it('matches an expected term written with a typographic apostrophe', () => {
    const result = gradeTurn(
      { ...base, expect: ["teacher's"] },
      'Your chemistry teacher’s name is Ms Okonkwo.',
    );
    expect(result.passed).toBe(true);
  });
});
