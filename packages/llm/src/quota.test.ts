import { describe, expect, it } from 'vitest';
import { QuotaService, SESSION_WINDOW_MS, currentWeekEnd, currentWeekStart } from './quota.js';
import { currentWindowEnd, currentWindowStart, platformCostMicroUsd } from './quota.js';
import { costEquivalentTokens } from './quota.js';
import { PLATFORM_PRICING } from './config.js';

describe('platformCostMicroUsd', () => {
  it('matches hand-computed pricing', () => {
    // 64 * 0.1 + 4 * 0.5 = 8.4 -> 8. These are the exact token counts observed on
    // the first real call against gpt-5.6-luna, priced at gpt-6-luna rates, so this pins the metering to
    // reality rather than to itself.
    expect(platformCostMicroUsd({ inputTokens: 64, outputTokens: 4, cachedInputTokens: 0 })).toBe(
      8,
    );
  });

  it('prices cached input at the discounted rate', () => {
    const cost = platformCostMicroUsd({
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 900,
    });

    // 100 uncached * 0.1 + 900 cached * 0.01 + 100 out * 0.5 = 10 + 9 + 50
    expect(cost).toBe(69);
  });

  it('makes caching materially cheaper, which is the whole reason it is metered', () => {
    const uncached = platformCostMicroUsd({
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 0,
    });
    const cached = platformCostMicroUsd({
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 900,
    });

    expect(cached).toBeLessThan(uncached / 1.9);
  });

  it('never double-counts cached tokens as uncached', () => {
    // cachedInputTokens is a SUBSET of inputTokens. Treating it as additional
    // would silently overstate every bill.
    const allCached = platformCostMicroUsd({
      inputTokens: 500,
      outputTokens: 0,
      cachedInputTokens: 500,
    });
    expect(allCached).toBe(Math.round(500 * PLATFORM_PRICING.cachedInputMicroUsdPerToken));
  });

  it('clamps rather than going negative if cached exceeds input', () => {
    // Defensive: a provider reporting cached > input should not produce a
    // negative cost that silently credits the account.
    expect(
      platformCostMicroUsd({ inputTokens: 10, outputTokens: 0, cachedInputTokens: 999 }),
    ).toBeGreaterThanOrEqual(0);
  });

  it('returns an integer, so sums cannot drift', () => {
    const cost = platformCostMicroUsd({
      inputTokens: 333,
      outputTokens: 77,
      cachedInputTokens: 11,
    });
    expect(Number.isInteger(cost)).toBe(true);
  });
});

describe('costEquivalentTokens', () => {
  it('counts a cached token at a tenth and an output token at five', () => {
    const usage = { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 900 };
    // 100 * 0.1 + 900 * 0.01 + 100 * 0.5 = 69 micro-USD = 690 full-price input tokens
    expect(costEquivalentTokens(platformCostMicroUsd(usage))).toBe(690);
  });

  it('is the identity for uncached input', () => {
    expect(
      costEquivalentTokens(
        platformCostMicroUsd({ inputTokens: 500, outputTokens: 0, cachedInputTokens: 0 }),
      ),
    ).toBe(500);
  });
});

describe('quota window', () => {
  it('starts at the first of the month, UTC', () => {
    const start = currentWindowStart(new Date('2026-08-13T18:45:00Z'));
    expect(start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('ends at the first of the next month', () => {
    const end = currentWindowEnd(new Date('2026-08-13T18:45:00Z'));
    expect(end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('rolls over the year in December', () => {
    // Off-by-one here would give every student a free January.
    expect(currentWindowEnd(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('treats the very first instant of a month as the new window', () => {
    const start = currentWindowStart(new Date('2026-09-01T00:00:00Z'));
    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('exempt accounts', () => {
  /**
   * The operator pays for the platform key and has to be able to use the
   * product without metering themselves, while students stay capped. Before
   * this the only lever was the global quota, which raises the ceiling for
   * everyone at once -- so testing the product heavily meant either blocking
   * yourself or removing the cost control you built the cap for.
   */
  function serviceFor(unlimited: boolean, tokensUsed: number) {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ unlimited }],
          }),
        }),
      }),
    };
    /*
     * A realistic monthly figure, because the caps are derived from it now: a
     * hundred tokens a month divides down to a session cap of four, and a
     * fixture that small would make every number here a rounding artefact.
     */
    const service = new QuotaService(db as never, 2_000_000);
    /*
     * The usage scan is separate from the exemption lookup; stub it so the
     * test is about the limit decision and not about SQL shapes. Both windows
     * read through this one method, so stubbing it caps session and week
     * alike -- which is what "has already blown its allowance" means.
     */
    service.tokensUsedSince = async () => tokensUsed;
    return service;
  }

  it('lets an exempt account past a limit it has already blown', async () => {
    await expect(serviceFor(true, 5_000_000).assertWithinQuota('u1')).resolves.toBeUndefined();
  });

  it('still stops a normal account', async () => {
    // The session cap is the lower of the two, so it is the one a student
    // meets first and the one the message should be about.
    await expect(serviceFor(false, 5_000_000).assertWithinQuota('u1')).rejects.toThrow(/session/i);
  });

  it('leaves a normal account under the limit alone', async () => {
    await expect(serviceFor(false, 5_000).assertWithinQuota('u1')).resolves.toBeUndefined();
  });

  /**
   * Usage is still recorded for exempt accounts. An exemption that also hid
   * the spend would make the one account most likely to run up a bill the one
   * account nobody could see.
   */
  it('does not skip the usage scan for reporting purposes', async () => {
    const service = serviceFor(true, 4242);
    expect(await service.tokensUsedThisWindow('u1')).toBe(4242);
  });
});

/**
 * Two limits, and the arithmetic that sets them.
 *
 * The session cap is what an ordinary heavy afternoon reaches and it comes
 * back in hours; the weekly is the backstop and comes back on Monday. Getting
 * the split wrong is not a rounding error -- too small a session cap makes the
 * limit the thing a student notices most, and too large a one lets a week
 * disappear in an evening.
 */
describe('splitting a month into weeks and sessions', () => {
  const service = (monthly: number) => new QuotaService({} as never, monthly);

  it('divides the month by weeks in a year, not by four', () => {
    // A month is not four weeks; dividing by four hands out an extra
    // fortnight a year without anyone deciding to.
    expect(service(2_000_000).weeklyLimit).toBe(461_538);
    expect(service(2_000_000).weeklyLimit).toBeLessThan(500_000);
  });

  it('lets one session spend a fifth of the week', () => {
    // Five hard afternoons is the week. Faster than the week's own pace,
    // which is the point of having a session window at all.
    expect(service(2_000_000).sessionLimit).toBe(92_307);
  });

  it('keeps the session cap well above a strictly pro-rata slice', () => {
    // A week holds about 33 five-hour windows. An even split would be a
    // thirty-third, which is a handful of messages.
    const weekly = service(2_000_000).weeklyLimit;
    expect(service(2_000_000).sessionLimit).toBeGreaterThan((weekly / 168) * 5 * 5);
  });

  it('scales with whatever the deployment allows', () => {
    expect(service(4_000_000).weeklyLimit).toBe(service(2_000_000).weeklyLimit * 2);
  });
});

describe('when a week starts', () => {
  it('starts on Monday, at midnight UTC', () => {
    // 2026-09-05 is a Saturday.
    expect(currentWeekStart(new Date('2026-09-05T13:00:00Z')).toISOString()).toBe(
      '2026-08-31T00:00:00.000Z',
    );
  });

  it('treats Sunday as the end of a week, not the start of one', () => {
    /*
     * getUTCDay calls Sunday 0, which would make it the first day and reset a
     * student's week a day early -- every Sunday, for ever.
     */
    expect(currentWeekStart(new Date('2026-09-06T23:59:00Z')).toISOString()).toBe(
      '2026-08-31T00:00:00.000Z',
    );
  });

  it('rolls over on Monday morning', () => {
    expect(currentWeekStart(new Date('2026-09-07T00:00:01Z')).toISOString()).toBe(
      '2026-09-07T00:00:00.000Z',
    );
  });

  it('ends exactly seven days after it starts', () => {
    const now = new Date('2026-09-03T09:00:00Z');
    const span = currentWeekEnd(now).getTime() - currentWeekStart(now).getTime();
    expect(span).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('crosses a month boundary without losing a day', () => {
    // The week of 31 August runs into September.
    expect(currentWeekEnd(new Date('2026-08-31T00:00:00Z')).toISOString()).toBe(
      '2026-09-07T00:00:00.000Z',
    );
  });
});

describe('the burst window', () => {
  it('is five hours', () => {
    expect(SESSION_WINDOW_MS).toBe(5 * 60 * 60 * 1000);
  });
});
