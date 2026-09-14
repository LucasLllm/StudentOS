/**
 * Model + pricing configuration for the platform (subsidised) tier.
 *
 * This is the file to edit when you change what we pay for. Nothing else in
 * the codebase should name a model string.
 */

/**
 * The model the platform tier runs on.
 *
 * GPT-5.6 Luna: $0.20 / $1.20 per million tokens, 1.05M context, 128K output.
 * Chosen over the cheaper GPT-5 mini ($0.125/$1.00) because Luna is the
 * current generation -- starting a new product on a two-generation-old model
 * schedules a migration for no benefit -- and because the 1.05M window gives
 * accumulated agent memory room before summarisation has to get aggressive.
 *
 * Verified against GET /v1/models: `gpt-5.6-luna`, alongside `gpt-5.6-terra`
 * and `gpt-5.6-sol`.
 */
export const PLATFORM_MODEL = 'gpt-5.6-luna';

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
 * without float drift. $0.20 per million tokens = 0.2 micro-USD per token.
 */
export const PLATFORM_PRICING = {
  inputMicroUsdPerToken: 0.2,
  outputMicroUsdPerToken: 1.2,
  /** Cached prefix reads are ~90% off. This is the main lever on our cost. */
  cachedInputMicroUsdPerToken: 0.02,
} as const;

/**
 * Default allowance for a student on the platform tier, in cost-equivalent
 * full-price input tokens -- see `costEquivalentTokens` in quota.ts. 5M of
 * them is $1.00/month at $0.20 per million.
 *
 * Estimated sizing, not measured: at roughly $0.002 per turn (a cached
 * transcript plus an xhigh-reasoning reply), ~500 typical turns a month
 * should still fit. Re-check against production `llm_usage` averages
 * (`select avg(cost_micro_usd) from llm_usage where provider = 'platform'`)
 * before changing this again.
 *
 * Students on their own API key are not metered against this at all.
 */
export const DEFAULT_MONTHLY_TOKEN_QUOTA = 5_000_000;

/**
 * Upgrade path, for when a school is paying:
 *   GPT-5.6 Terra  $2.00 / $12.00  -- balanced production tier
 *   GPT-5.6 Sol    $5.00 / $30.00  -- frontier tier
 * Adding one is a second entry in the provider registry, not a refactor.
 */
