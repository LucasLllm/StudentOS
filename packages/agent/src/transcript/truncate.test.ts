import { describe, expect, it } from 'vitest';
import { TOOL_RESULT_MAX_CHARS, truncateToolResult } from './truncate.js';

describe('truncateToolResult', () => {
  it('leaves a result under the cap alone', () => {
    expect(truncateToolResult('short')).toEqual({ text: 'short', truncated: false });
  });

  it('keeps the head and the tail and says how much went', () => {
    const text = 'a'.repeat(30) + 'b'.repeat(40) + 'c'.repeat(30);
    const { text: cut, truncated } = truncateToolResult(text, 60);
    expect(truncated).toBe(true);
    expect(cut.startsWith('a'.repeat(30))).toBe(true);
    expect(cut.endsWith('c'.repeat(30))).toBe(true);
    expect(cut).toContain('40 characters truncated');
    expect(cut).toContain('narrower request');
  });

  it('caps at ten thousand tokens by default', () => {
    expect(TOOL_RESULT_MAX_CHARS).toBe(40_000);
    expect(truncateToolResult('x'.repeat(40_001)).truncated).toBe(true);
  });
});
