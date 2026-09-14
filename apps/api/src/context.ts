import { createDatabase, type Database } from '@contexto/db';
import { CredentialVault, EnvMasterKeyProvider, LlmRegistry, QuotaService } from '@contexto/llm';
import {
  PostgresMemoryStore,
  PostgresPlanStore,
  PostgresSkillRegistry,
  PostgresTranscriptStore,
} from '@contexto/agent';
import { TelegramChannel } from '@contexto/channels';
import { createAuth, type Auth } from './auth.js';
import { OpenAiTranscriber } from './transcription.js';
import { GoogleYoutubeMetadata } from './youtube.js';
import { TranscriptApiSource } from './youtube-transcript.js';
import { ChainedTranscriptSource, FreeTranscriptSource } from './youtube-transcript-free.js';
import { createRelayEgress, createResidentialEgress, type Egress } from './egress.js';
import type { YoutubeTranscriptSource } from '@contexto/agent';
import type { Env } from './env.js';

/**
 * Application wiring.
 *
 * Everything is constructed once at boot and passed down. This is the only
 * place that decides which MasterKeyProvider is used -- swapping the env-var
 * one for a KMS-backed one is a change to this file and nowhere else.
 */
export interface AppContext {
  env: Env;
  db: Database;
  auth: Auth;
  llm: LlmRegistry;
  vault: CredentialVault;
  quota: QuotaService;
  memory: PostgresMemoryStore;
  skills: PostgresSkillRegistry;
  /** What every turn replays: this chat, as it actually happened. */
  transcript: PostgresTranscriptStore;
  /** The plan the model keeps for a chat, recited back to it every turn. */
  plans: PostgresPlanStore;
  /** Undefined when the Telegram gateway is not configured. */
  telegram: TelegramChannel | undefined;
  /** Undefined when there is no platform key to transcribe with. */
  transcriber: OpenAiTranscriber | undefined;
  /** Always present: falls back to keyless oEmbed when no API key is set. */
  youtube: GoogleYoutubeMetadata;
  /** Always present: the free source needs no key. */
  youtubeTranscripts: YoutubeTranscriptSource;
  /** Undefined when no residential proxy is configured. */
  residential: Egress | undefined;
}

export function createContext(env: Env): AppContext {
  const db = createDatabase({ url: env.DATABASE_URL });

  // Shared by everything that can be datacenter-blocked, not just YouTube.
  /*
   * A relay at home wins over a rented proxy when both are set: same
   * capability, an IP you already own, and no metered bandwidth.
   */
  const residential =
    env.RELAY_URL && env.RELAY_TOKEN
      ? createRelayEgress(env.RELAY_URL, env.RELAY_TOKEN)
      : createResidentialEgress(env.RESIDENTIAL_PROXY_URL);

  const masterKey = new EnvMasterKeyProvider(env.MASTER_ENCRYPTION_KEY);
  const vault = new CredentialVault(db, masterKey);
  const quota = new QuotaService(db, env.PLATFORM_MONTHLY_TOKEN_QUOTA);

  return {
    env,
    db,
    auth: createAuth(db, env),
    vault,
    quota,
    llm: new LlmRegistry({
      vault,
      quota,
      platformApiKey: env.PLATFORM_OPENAI_API_KEY,
    }),
    memory: new PostgresMemoryStore(db),
    skills: new PostgresSkillRegistry(db),
    transcript: new PostgresTranscriptStore(db),
    plans: new PostgresPlanStore(db),

    // Shares the platform key. A student on their own OpenAI key still gets
    // transcription; it is not metered per student either way.
    transcriber: env.PLATFORM_OPENAI_API_KEY
      ? new OpenAiTranscriber(env.PLATFORM_OPENAI_API_KEY)
      : undefined,

    // Constructed unconditionally: without a key it still answers from
    // oEmbed, which needs none and works today.
    residential,
    youtube: new GoogleYoutubeMetadata(env.YOUTUBE_API_KEY),
    /*
     * Free first, paid second. The free route costs nothing when it works,
     * and its failures are indistinguishable from a bot wall -- so a key,
     * when set, covers exactly the videos it cannot reach.
     */
    /*
     * Cheapest first. Direct costs nothing and works for videos this host is
     * not blocked from; the proxy is only reached when it is; the paid API is
     * the last resort. Each tier is skipped entirely when unconfigured.
     */
    youtubeTranscripts: new ChainedTranscriptSource([
      new FreeTranscriptSource(),
      ...(residential ? [new FreeTranscriptSource(residential.fetch)] : []),
      ...(env.YOUTUBE_TRANSCRIPT_API_KEY
        ? [new TranscriptApiSource(env.YOUTUBE_TRANSCRIPT_API_KEY)]
        : []),
    ]),

    // env.ts guarantees the secret is present whenever the token is.
    telegram:
      env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET
        ? new TelegramChannel({
            botToken: env.TELEGRAM_BOT_TOKEN,
            webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
          })
        : undefined,
  };
}
