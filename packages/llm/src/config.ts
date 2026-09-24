/**
 * Model + pricing configuration for the platform (subsidised) tier.
 *
 * This is the file to edit when you change what we pay for. Nothing else in
 * the codebase should name a model string.
 */

/**
 * The model the platform tier runs on.
 *
 * GPT-6 Luna: $0.10 / $0.50 per million tokens, 1.05M context, 128K output.
 * Replaced GPT-5.6 Luna ($0.20 / $1.20) on its launch day, 23 September 2026:
 * same context and output limits and the same reasoning efforts, at half the
 * input price and under half the output price. Luna because the 1.05M window
 * gives accumulated agent memory room before summarisation has to get
 * aggressive.
 *
 * Model id per OpenAI's model page: `gpt-6-luna`, alongside `gpt-6-sol`.
 */
export const PLATFORM_MODEL = 'gpt-6-luna';

/**
 * The model that turns class recordings into text.
 *
 * gpt-4o-mini-transcribe rather than the full gpt-4o-transcribe: this is
 * classroom speech, where the cheaper model is accurate enough, and every
 * video a student opens is billed per minute rather than per token.
 *
 * gpt-4o-transcribe-diarize also exists on this key and labels speakers. That
 * is the right model for the lecture-capture feature when it arrives, and the
 * wrong one for reading a teacher's screencast.
 *
 * Verified against GET /v1/models.
 */
export const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

/**
 * Prices in micro-USD per token, so usage rows can be summed as integers
 * without float drift. $0.10 per million tokens = 0.1 micro-USD per token.
 */
export const PLATFORM_PRICING = {
  inputMicroUsdPerToken: 0.1,
  outputMicroUsdPerToken: 0.5,
  /** Cached prefix reads are ~90% off. This is the main lever on our cost. */
  cachedInputMicroUsdPerToken: 0.01,
} as const;

/**
 * Default allowance for a student on the platform tier, in cost-equivalent
 * full-price input tokens -- see `costEquivalentTokens` in quota.ts. 10M of
 * them is $1.00/month at $0.10 per million. Doubled from 5M when the input
 * price halved, so the dollar budget stayed put; the unit is tied to the
 * input price, so any change to it moves this too.
 *
 * Estimated sizing, not measured: at roughly $0.001 per turn (a cached
 * transcript plus an xhigh-reasoning reply), ~1000 typical turns a month
 * should still fit. Re-check against production `llm_usage` averages
 * (`select avg(cost_micro_usd) from llm_usage where provider = 'platform'`)
 * before changing this again.
 *
 * Students on their own API key are not metered against this at all.
 */
export const DEFAULT_MONTHLY_TOKEN_QUOTA = 10_000_000;

/**
 * Upgrade path, for when a school is paying:
 *   GPT-6 Sol -- frontier tier (price it from OpenAI's pricing page first)
 * Adding one is a second entry in the provider registry, not a refactor.
 */
