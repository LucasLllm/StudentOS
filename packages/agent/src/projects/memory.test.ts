import { describe, expect, it } from 'vitest';
import { PROJECT_MEMORY_LIMIT, updateProjectMemory } from './memory.js';

/**
 * What earlier chats in a project established, kept for the next one.
 *
 * Written between conversations, never during one, and bounded: a memory that
 * only grows ends up costing every turn of every chat in the project more.
 */

function model(content: string) {
  const seen: string[] = [];
  return {
    seen,
    llm: {
      chat: async (request: { messages: { content: string }[] }) => {
        seen.push(request.messages.map((m) => m.content).join('\n'));
        return { content, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    },
  };
}

const project = { name: 'CAS proposal', instructions: 'Get it approved.' };

describe('updateProjectMemory', () => {
  it('writes the new memory from what was said', async () => {
    const m = model('- Budget settled at $400.');
    const next = await updateProjectMemory(
      { llm: m.llm as never },
      { ...project, memory: '', exchanges: ['Student: budget?\nAgent: $400'], userId: 'u1' },
    );
    expect(next).toBe('- Budget settled at $400.');
    expect(m.seen[0]).toContain('Student: budget?');
  });

  it('says unchanged when the chat established nothing', async () => {
    const next = await updateProjectMemory(
      { llm: model('UNCHANGED').llm as never },
      { ...project, memory: '- x', exchanges: ['Student: hi\nAgent: hi'], userId: 'u1' },
    );
    expect(next).toBeNull();
  });

  it('costs nothing when there is nothing new', async () => {
    const m = model('- y');
    const next = await updateProjectMemory(
      { llm: m.llm as never },
      { ...project, memory: '- x', exchanges: [], userId: 'u1' },
    );
    expect(next).toBeNull();
    expect(m.seen).toHaveLength(0);
  });

  it('is kept within its limit', async () => {
    const next = await updateProjectMemory(
      { llm: model('- fact\n'.repeat(3000)).llm as never },
      { ...project, memory: '', exchanges: ['Student: a\nAgent: b'], userId: 'u1' },
    );
    expect(next!.length).toBeLessThanOrEqual(PROJECT_MEMORY_LIMIT);
  });
});
