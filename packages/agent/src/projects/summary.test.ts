import { describe, expect, it } from 'vitest';
import { summariseSource } from './summary.js';

/** One line per context item, written once. It must never fail the add. */

const reply = (content: string) => ({
  chat: async () => ({ content, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }),
});

describe('summariseSource', () => {
  const input = {
    userId: 'u1',
    title: 'budget.pdf',
    body: 'The   budget\nfor the incubator is $400.',
  };

  it('keeps the first line, trimmed', async () => {
    const said = await summariseSource(
      { llm: reply('  Incubator budget of $400.\nMore') as never },
      input,
    );
    expect(said).toBe('Incubator budget of $400.');
  });

  it('caps it at 160 characters', async () => {
    const said = await summariseSource({ llm: reply('x'.repeat(400)) as never }, input);
    expect(said.length).toBeLessThanOrEqual(160);
  });

  it('falls back to the opening of the text when the model fails', async () => {
    const llm = {
      chat: async () => {
        throw new Error('down');
      },
    };
    expect(await summariseSource({ llm: llm as never }, input)).toBe(
      'The budget for the incubator is $400.',
    );
  });

  it('falls back when the model says nothing', async () => {
    expect(await summariseSource({ llm: reply('   ') as never }, input)).toBe(
      'The budget for the incubator is $400.',
    );
  });
});
