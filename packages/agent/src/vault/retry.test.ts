import { describe, expect, it, vi } from 'vitest';
import { waitFor, worthRetrying } from './retry.js';

/**
 * How long to wait before trying again.
 *
 * Two full passes over a real vault failed 38% and then 43% of their files,
 * every sampled one of which read fine on a later attempt. The failures were
 * a per-minute token budget staying saturated for longer than the fixed
 * backoff -- four tries over twenty-three seconds against a limit that resets
 * on a rolling minute.
 *
 * The provider says how long it wants: "Please try again in 28.878s". Ignoring
 * that and guessing shorter is the whole bug.
 */

describe('what a rate limit is worth waiting', () => {
  it('waits as long as the provider asked for, in seconds', () => {
    const error = new Error(
      'Rate limit reached for gpt-6-luna on tokens per min (TPM): Limit 200000, ' +
        'Used 199346, Requested 2664. Please try again in 28.878s.',
    );
    // A little over, never under: coming back a moment early is another 429
    // and another attempt spent.
    expect(waitFor(error, 0)).toBeGreaterThanOrEqual(28_878);
    expect(waitFor(error, 0)).toBeLessThan(35_000);
  });

  it('understands a wait given in milliseconds', () => {
    expect(waitFor(new Error('Please try again in 603ms.'), 0)).toBeGreaterThanOrEqual(603);
    expect(waitFor(new Error('Please try again in 603ms.'), 0)).toBeLessThan(2000);
  });

  it('falls back to a widening wait when nothing is suggested', () => {
    const plain = new Error('503 Service Unavailable');
    const first = waitFor(plain, 0) ?? 0;
    const later = waitFor(plain, 2) ?? 0;
    expect(first).toBeLessThan(later);
  });

  it('is willing to wait out a whole minute', () => {
    /*
     * The limit resets on a rolling minute, so a backoff that gives up inside
     * one can never clear a saturated budget -- which is exactly how 33 files
     * survived two passes that were meant to read them.
     */
    const plain = new Error('429 rate limit');
    const total = [0, 1, 2, 3, 4].reduce((sum, attempt) => sum + (waitFor(plain, attempt) || 0), 0);
    expect(total).toBeGreaterThan(60_000);
  });

  it('refuses to wait absurdly long, whatever it is told', () => {
    // A malformed or hostile hint should not park an import for an hour.
    expect(waitFor(new Error('try again in 99999s'), 0)).toBeLessThanOrEqual(90_000);
  });

  it('gives up eventually rather than retrying for ever', () => {
    expect(waitFor(new Error('429'), 99)).toBeNull();
  });
});

describe('what is worth retrying at all', () => {
  it('retries a rate limit and a server fault', () => {
    expect(worthRetrying(new Error('429 rate limit reached'))).toBe(true);
    expect(worthRetrying({ status: 503 })).toBe(true);
  });

  it('does not retry a request the provider rejected outright', () => {
    expect(worthRetrying(new Error('400 context length exceeded'))).toBe(false);
  });
});

describe('sanity', () => {
  it('does not sleep in tests by accident', () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});
