import { describe, expect, it } from 'vitest';
import { modifiedLabel } from './when.js';

describe('modifiedLabel', () => {
  const now = new Date(2026, 8, 22, 21, 0);

  it('says Today and Yesterday by the calendar, not by 24 hours', () => {
    expect(modifiedLabel(new Date(2026, 8, 22, 0, 5).toISOString(), now)).toBe('Today');
    expect(modifiedLabel(new Date(2026, 8, 21, 23, 55).toISOString(), now)).toBe('Yesterday');
  });

  it('gives a date after that, and the year only when it is another one', () => {
    expect(modifiedLabel(new Date(2026, 8, 7).toISOString(), now)).toBe('Sep 7');
    expect(modifiedLabel(new Date(2025, 8, 7).toISOString(), now)).toBe('Sep 7, 2025');
  });

  it('says nothing for a date it cannot read', () => {
    expect(modifiedLabel('not a date', now)).toBe('');
  });
});
