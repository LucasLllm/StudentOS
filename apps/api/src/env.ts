import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Load the repo-root .env into process.env, if it exists.
 *
 * Walks up from this file rather than relying on cwd, because cwd differs
 * between `pnpm dev` from the repo root and running the app from apps/api --
 * and a loader that silently finds nothing is worse than no loader at all.
 *
 * Node's loadEnvFile does not overwrite variables already in the environment,
 * which is the behaviour we want: a real environment variable on the droplet
 * beats a stale .env someone left lying around.
 */
function loadDotEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return; // hit the filesystem root
    dir = parent;
  }
}

/**
 * Treat `KEY=` in a .env file as "not set".
 *
 * Zod's .optional() only admits `undefined`, but a commented-out-by-emptying
 * variable arrives as an empty string. Without this, `PLATFORM_MONTHLY_TOKEN_QUOTA=`
 * coerces to 0 and fails the positive check, and an empty API key would be
 * "present" but useless. An empty value in a .env file always means absent.
 */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

/**
 * Environment validation.
 *
 * Everything is validated at boot so a missing secret is a startup crash with a
 * useful message, not a 500 three days later when someone first tries to add an
 * API key. See .env.example.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),

  /** Public origin of this API. Must match the Google redirect URI's origin. */
  API_BASE_URL: z.url(),
  /** Where the SPA is served. Used for CORS and post-login redirects. */
  WEB_BASE_URL: z.url(),

  /** Better Auth signing secret. openssl rand -base64 32 */
  AUTH_SECRET: z.string().min(32),

  /**
   * Master key for encrypting students' API keys. 32 bytes, base64.
   *   openssl rand -base64 32
   *
   * Losing this makes every stored credential permanently unreadable -- there
   * is no recovery path, students would have to re-enter their keys. Back it up
   * somewhere other than the droplet it runs on.
   */
  MASTER_ENCRYPTION_KEY: z.string().min(1),

  /**
   * Who may read the debug page: every student's browser traces, screenshots
   * included. Comma-separated emails, compared case-insensitively. Unset means
   * nobody -- the routes answer 404 to everyone.
   */
  DEVELOPER_EMAILS: optional(z.string()),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),

  /**
   * Our OpenAI key, funding the free tier. Optional: leave it unset and every
   * student must bring their own key, which is a legitimate way to run this
   * before you want an inference bill.
   */
  PLATFORM_OPENAI_API_KEY: optional(z.string().min(1)),
  /** Per-student monthly token allowance on the platform tier. */
  PLATFORM_MONTHLY_TOKEN_QUOTA: optional(z.coerce.number().int().positive()),

  /**
   * Where ContextoVaults live on disk, one directory per agent.
   *
   * Optional: a deployment without it simply has no vaults, and every agent
   * behaves as it did before they existed.
   */
  VAULT_ROOT: optional(z.string().min(1)),

  /**
   * Live sync. All optional; without them the live tier polls on
   * VAULT_LIVE_POLL_MINUTES and nothing is pushed.
   *
   * GMAIL_PUBSUB_TOPIC is the full name, projects/<id>/topics/<name>, of a
   * topic Gmail may publish to. See deploy/README.md for the Console steps.
   */
  GMAIL_PUBSUB_TOPIC: optional(z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/)),
  /** Shared secret in the Pub/Sub push URL. Required with GMAIL_PUBSUB_TOPIC. */
  VAULT_HOOK_SECRET: optional(z.string().min(16)),
  /** How often the poll trigger rings every student's bell. 0 disables it. */
  VAULT_LIVE_POLL_MINUTES: z.coerce.number().int().min(0).default(5),
  /** How long one slow pass may keep starting students. */
  VAULT_REFRESH_BUDGET_MINUTES: z.coerce.number().int().positive().default(50),

  /**
   * Telegram gateway. Both optional -- unset disables the gateway entirely,
   * and the product must work without it.
   */
  /*
   * Optional. Without it YouTube lookups fall back to oEmbed, which needs no
   * key and returns title and channel -- enough for the agent to say what a
   * link is. With it, the Data API adds the description and duration, which
   * for teaching material is usually the substance.
   */
  YOUTUBE_API_KEY: optional(z.string().min(1)),
  /*
   * Optional. Without it the agent can say what a YouTube video IS but not
   * what it says -- YouTube blocks caption access from datacenter IPs by
   * every route, so a service with a residential pool is the only way in.
   */
  YOUTUBE_TRANSCRIPT_API_KEY: optional(z.string().min(1)),
  /*
   * Optional residential proxy, as a standard URL:
   *   http://user:pass@gate.provider.com:7777
   *
   * Used only for requests that were refused directly, so cost tracks the
   * blocking rather than the traffic. Not YouTube-specific -- any host that
   * serves a bot wall to cloud IPs can be retried through it.
   */
  RESIDENTIAL_PROXY_URL: optional(z.string().url()),
  /*
   * A relay on a machine at home, reached over a tunnel. Preferred over a
   * rented proxy: the residential IP is one you already own, so there is no
   * per-gigabyte bill and no third party in the path.
   */
  RELAY_URL: optional(z.string().url()),
  RELAY_TOKEN: optional(z.string().min(32)),
  TELEGRAM_BOT_TOKEN: optional(z.string().min(1)),
  /** Shared secret echoed back by Telegram on every webhook request. */
  TELEGRAM_WEBHOOK_SECRET: optional(z.string().min(16)),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  // Only touch the filesystem when reading the real environment -- tests pass
  // an explicit source and should not pick up whatever is in the developer's
  // .env file.
  if (!source) {
    loadDotEnv();
    source = process.env;
  }

  const parsed = envSchema
    // A bot token without a webhook secret means an unauthenticated public
    // endpoint that runs agent turns. Refuse to start rather than expose it.
    .refine((env) => !env.RELAY_URL || Boolean(env.RELAY_TOKEN), {
      path: ['RELAY_TOKEN'],
      message:
        'Required when RELAY_URL is set -- an unauthenticated relay lets anyone who finds ' +
        'the tunnel make requests from your home connection.',
    })
    .refine((env) => !env.TELEGRAM_BOT_TOKEN || Boolean(env.TELEGRAM_WEBHOOK_SECRET), {
      path: ['TELEGRAM_WEBHOOK_SECRET'],
      message:
        'Required when TELEGRAM_BOT_TOKEN is set -- without it, anyone who finds the ' +
        'webhook URL can forge messages. Generate one with: openssl rand -hex 32',
    })
    .refine((env) => !env.GMAIL_PUBSUB_TOPIC || Boolean(env.VAULT_HOOK_SECRET), {
      path: ['VAULT_HOOK_SECRET'],
      message:
        'Required when GMAIL_PUBSUB_TOPIC is set -- without it anyone who finds the hook ' +
        "URL can ring every student's bell. Generate one with: openssl rand -hex 32",
    })
    .safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }

  return parsed.data;
}
