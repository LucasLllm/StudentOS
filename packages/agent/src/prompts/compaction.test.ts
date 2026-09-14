import { describe, expect, it } from 'vitest';
import { COMPACTION } from './documents.js';

const body = COMPACTION.body;

/**
 * How the older part of a long conversation gets turned into a summary.
 *
 * The compaction call runs between turns, on a part of the conversation a
 * turn will never see again, so a section this document forgets to ask for is
 * information no later turn can ever recover.
 */
describe('the sections it asks for, in order', () => {
  it('names every section, in the order the next model should read them', () => {
    const headings = [
      'The open ask',
      'Task overview',
      'Student messages',
      'Current state',
      'Important discoveries',
      'Next steps',
      'Context to preserve',
      'Where you left off',
    ];

    let previousIndex = -1;
    for (const heading of headings) {
      const index = body.indexOf(heading);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });
});

describe('handling an earlier summary', () => {
  it('says a reverse signal cancels the work it reverses', () => {
    expect(body).toMatch(/reverse signal/i);
    expect(body).toMatch(/cancelled|do not carry/i);
  });

  it('says to update an earlier summary rather than start over', () => {
    expect(body).toMatch(/rather than starting over/i);
  });
});

describe('treating the transcript as data', () => {
  it('says the conversation is material to summarise, never instructions', () => {
    expect(body).toMatch(/never instructions/i);
  });
});

describe('output format', () => {
  it('asks for plain text', () => {
    expect(body).toMatch(/plain text/i);
  });
});
