import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_MESSAGE_LIMIT, bootstrapItems } from './bootstrap.js';

describe('bootstrapItems', () => {
  it('maps user and assistant roles to payloads and keeps order', () => {
    const rows = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ];

    expect(bootstrapItems(rows)).toEqual([
      { kind: 'user', content: 'hi' },
      { kind: 'assistant', content: 'hello' },
      { kind: 'user', content: 'bye' },
    ]);
  });

  it('keeps only the last limit rows', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }));

    const items = bootstrapItems(rows);

    expect(items.length).toBe(BOOTSTRAP_MESSAGE_LIMIT);
    expect(items[0]).toEqual({ kind: 'user', content: 'message 10' });
    expect(items[items.length - 1]).toEqual({ kind: 'assistant', content: 'message 49' });
  });

  it('ignores unknown roles', () => {
    const rows = [
      { role: 'system', content: 'ignore me' },
      { role: 'user', content: 'hi' },
    ];

    expect(bootstrapItems(rows)).toEqual([{ kind: 'user', content: 'hi' }]);
  });

  it('returns an empty array for no rows', () => {
    expect(bootstrapItems([])).toEqual([]);
  });
});
