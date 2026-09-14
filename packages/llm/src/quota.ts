import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '@contexto/db';
import { llmUsage, user } from '@contexto/db';
import type { ProviderId } from '@contexto/shared';
import { ContextoError } from '@contexto/shared';
import { DEFAULT_MONTHLY_TOKEN_QUOTA, PLATFORM_PRICING } from './config.js';
import type { TokenUsage } from './types.js';

/**
 * Metering and per-student limits for the platform tier.
 *
 * Only platform-tier calls are gated. A student on their own key is billed by
 * the provider directly, so capping them would be us restricting something we
 * are not paying for.
 */
export class QuotaService {
  constructor(
    private readonly db: Database,
    private readonly monthlyTokenQuota: number = DEFAULT_MONTHLY_TOKEN_QUOTA,
  ) {}

  /**
   * Throws `quota_exceeded` if the student is over their allowance.
   *
   * Called before the request, so the check races a concurrent one -- two
   * simultaneous calls can both pass at the boundary. That is deliberate:
   * serialising every inference call behind a lock costs more than the handful
   * of tokens it would save.
   */
  async assertWithinQuota(userId: string): Promise<void> {
    // Checked first: an exempt account should not pay for a usage scan on
    // every turn to reach a limit that will never apply to it.
    if (await this.isExempt(userId)) return;

    /*
     * Two limits, checked in the order a student meets them.
     *
     * The session cap is the one an ordinary heavy afternoon reaches, and it
     * comes back in hours; the weekly is the backstop and comes back on
     * Monday. Reporting the wrong one would send a student away for six days
     * over a wait of two hours, so they are checked separately and say
     * different things.
     */
    const now = new Date();
    const [session, week] = await Promise.all([
      this.tokensUsedSince(userId, new Date(now.getTime() - SESSION_WINDOW_MS)),
      this.tokensUsedSince(userId, currentWeekStart(now)),
    ]);

    if (session >= this.sessionLimit) {
      throw new ContextoError(
        'quota_exceeded',
        'You have used this session\u2019s allowance. It refills over the next few hours -- ' +
          'or add your own API key for unlimited use.',
      );
    }

    if (week >= this.weeklyLimit) {
      throw new ContextoError(
        'quota_exceeded',
        'You have used this week\u2019s allowance. It resets on Monday -- or add your own ' +
          'API key for unlimited use.',
      );
    }
  }

  /**
   * Whether this account is exempt from the allowance.
   *
   * Usage is still RECORDED for exempt accounts -- what it cost remains
   * visible, only the limit stops applying. An exemption that also hid the
   * spend would make the one account most likely to run up a bill the one
   * nobody could see.
   */
  async isExempt(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ unlimited: user.unlimitedUsage })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    return row?.unlimited === true;
  }

  async tokensUsedThisWindow(userId: string): Promise<number> {
    return this.tokensUsedSince(userId, currentWindowStart());
  }

  /**
   * Platform cost spent by this student since a moment, expressed as
   * cost-equivalent tokens.
   *
   * The quota exists to bound what a student costs, not how many tokens they
   * touched. Summing raw input + output tokens made a long cached chat look
   * ten times dearer than it actually was, and made a reasoning-heavy reply
   * -- billed at six times the input rate -- look six times cheaper. Summing
   * `cost_micro_usd` and converting back through the input price fixes both.
   */
  async tokensUsedSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${llmUsage.costMicroUsd}), 0)`,
      })
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.userId, userId),
          eq(llmUsage.provider, 'platform'),
          gte(llmUsage.createdAt, since),
        ),
      );

    return costEquivalentTokens(Number(row?.total ?? 0));
  }

  /** Where the student stands against both limits, for the usage screen. */
  async standing(userId: string, now = new Date()): Promise<QuotaStanding> {
    const [session, week] = await Promise.all([
      this.tokensUsedSince(userId, new Date(now.getTime() - SESSION_WINDOW_MS)),
      this.tokensUsedSince(userId, currentWeekStart(now)),
    ]);

    return {
      session: { used: session, limit: this.sessionLimit, resetsAt: null },
      week: {
        used: week,
        limit: this.weeklyLimit,
        resetsAt: currentWeekEnd(now).toISOString(),
      },
    };
  }

  /** Record a completed call. BYOK rows are stored but never gate anything. */
  async record(input: {
    userId: string;
    agentId?: string;
    provider: ProviderId;
    model: string;
    usage: TokenUsage;
  }): Promise<void> {
    await this.db.insert(llmUsage).values({
      userId: input.userId,
      agentId: input.agentId ?? null,
      provider: input.provider,
      model: input.model,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      costMicroUsd: input.provider === 'platform' ? platformCostMicroUsd(input.usage) : 0,
    });
  }

  get limit(): number {
    return this.monthlyTokenQuota;
  }

  /**
   * The month's allowance, spread evenly over weeks.
   *
   * Twelve months over fifty-two weeks rather than a quarter, because a month
   * is not four weeks and dividing by four quietly hands out an extra fortnight
   * a year.
   */
  get weeklyLimit(): number {
    return Math.floor((this.monthlyTokenQuota * 12) / 52);
  }

  /**
   * What one five-hour stretch may spend.
   *
   * A fifth of the week, so a student can work hard for an afternoon without
   * the week's pace holding them back -- and five such afternoons is the week.
   * A strictly pro-rata slice would be a thirty-third of the week, which is
   * about twenty messages, and would make the cap the thing they notice most.
   */
  get sessionLimit(): number {
    return Math.floor(this.weeklyLimit / 5);
  }
}

/**
 * The burst window: five hours, trailing.
 *
 * Trailing rather than anchored to a first message, which needs no session
 * row and no decision about when one ends. What it means to a student is the
 * same thing either way -- what you have spent in the last five hours -- and
 * it recovers gradually rather than all at once, which is the kinder shape.
 */
export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

export interface QuotaBar {
  used: number;
  limit: number;
  /** Null where the window is trailing and has no single moment of reset. */
  resetsAt: string | null;
}

export interface QuotaStanding {
  session: QuotaBar;
  week: QuotaBar;
}

/**
 * ISO weeks, starting Monday 00:00 UTC.
 *
 * A fixed weekly reset rather than a rolling seven days: "resets Monday" is
 * something a student can plan around, where "resets whenever the oldest of
 * your last seven days falls off" is not.
 */
export function currentWeekStart(now = new Date()): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay is 0 for Sunday, which is six days into an ISO week, not none.
  const since = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - since);
  return start;
}

export function currentWeekEnd(now = new Date()): Date {
  const end = currentWeekStart(now);
  end.setUTCDate(end.getUTCDate() + 7);
  return end;
}

/** Calendar-month windows. Simple to explain to a student, simple to query. */
export function currentWindowStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function currentWindowEnd(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * What a call actually cost us, in integer micro-USD.
 *
 * Uncached and cached input are priced separately because the gap between them
 * is roughly 10x -- it is the difference between the platform tier being
 * affordable and not.
 */
export function platformCostMicroUsd(usage: TokenUsage): number {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return Math.round(
    uncachedInput * PLATFORM_PRICING.inputMicroUsdPerToken +
      usage.cachedInputTokens * PLATFORM_PRICING.cachedInputMicroUsdPerToken +
      usage.outputTokens * PLATFORM_PRICING.outputMicroUsdPerToken,
  );
}

/**
 * A cost, expressed as the number of full-price input tokens it is worth.
 *
 * The quota's unit is cost, but a raw micro-USD figure means nothing to a
 * student or on a usage bar -- converting back through the input price gives
 * a number that reads like a token count while actually tracking spend.
 */
export function costEquivalentTokens(costMicroUsd: number): number {
  return Math.round(costMicroUsd / PLATFORM_PRICING.inputMicroUsdPerToken);
}
