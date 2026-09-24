import { ContextoError } from '@contexto/shared';
import { PLATFORM_MODEL } from './config.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAiProvider } from './providers/openai.js';
import type { QuotaService } from './quota.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  LlmProvider,
  ProviderContext,
} from './types.js';
import type { CredentialVault } from './vault.js';

export interface LlmRegistryOptions {
  vault: CredentialVault;
  quota: QuotaService;
  /**
   * Our OpenAI key, funding the free tier. Omit to disable the platform tier
   * entirely -- students then need their own key, and get a clear error if
   * they have not added one.
   */
  platformApiKey?: string;
  platformModel?: string;
}

/**
 * Decides who pays for a given student's inference, and is the only thing the
 * rest of the app talks to.
 *
 * Resolution order:
 *   1. The student's own API key, if they have added one.
 *   2. The platform tier, subject to quota.
 *   3. Error.
 *
 * ADDING A NEW TIER (hosted, school-funded, self-hosted) is a new branch in
 * `resolve` plus a class implementing LlmProvider. No caller changes, because
 * callers only ever see `chat`/`stream` on this class. Keep it that way -- the
 * moment a route imports a concrete provider, that property is gone.
 */
export class LlmRegistry {
  readonly #vault: CredentialVault;
  readonly #quota: QuotaService;
  readonly #platformApiKey: string | undefined;
  readonly #platformModel: string;

  constructor(options: LlmRegistryOptions) {
    this.#vault = options.vault;
    this.#quota = options.quota;
    this.#platformApiKey = options.platformApiKey;
    this.#platformModel = options.platformModel ?? PLATFORM_MODEL;
  }

  async resolve(userId: string): Promise<LlmProvider> {
    const credential = await this.#vault.getDecryptedKey(userId);

    if (credential) {
      switch (credential.provider) {
        case 'openai':
          return new OpenAiProvider({ apiKey: credential.apiKey, model: PLATFORM_MODEL });
        case 'anthropic':
          return new AnthropicProvider({ apiKey: credential.apiKey });
      }
    }

    if (!this.#platformApiKey) {
      throw new ContextoError(
        'no_provider_configured',
        'Add your own API key to start using your agent.',
      );
    }

    // Only the subsidised path is metered -- see QuotaService.
    await this.#quota.assertWithinQuota(userId);

    return new OpenAiProvider({
      apiKey: this.#platformApiKey,
      model: this.#platformModel,
      id: 'platform',
    });
  }

  /** Resolve, call, and meter. This is what agent code should use. */
  async chat(request: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> {
    const provider = await this.resolve(ctx.userId);
    const response = await provider.chat(request, ctx);

    await this.#quota.record({
      userId: ctx.userId,
      agentId: ctx.agentId,
      provider: provider.id,
      model: provider.model,
      usage: response.usage,
    });

    return response;
  }

  async *stream(request: ChatRequest, ctx: ProviderContext): AsyncIterable<ChatChunk> {
    const provider = await this.resolve(ctx.userId);

    for await (const chunk of provider.stream(request, ctx)) {
      if (chunk.type === 'done') {
        await this.#quota.record({
          userId: ctx.userId,
          agentId: ctx.agentId,
          provider: provider.id,
          model: provider.model,
          usage: chunk.usage,
        });
      }
      yield chunk;
    }
  }
}
