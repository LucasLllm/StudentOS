import type { ProviderId } from '@contexto/shared';

/**
 * The seam between the agent core and whoever is actually paying for inference.
 *
 * Call sites depend on this interface and nothing else. Adding a hosted tier, a
 * school-funded tier, or a self-hosted model later means writing one more
 * implementation and one registry rule -- no call site changes. That property
 * is the entire reason this package exists as a package.
 */
export interface LlmProvider {
  readonly id: ProviderId;
  /** Model this provider will use, for logging and usage rows. */
  readonly model: string;

  chat(request: ChatRequest, ctx: ProviderContext): Promise<ChatResponse>;
  stream(request: ChatRequest, ctx: ProviderContext): AsyncIterable<ChatChunk>;
}

export interface ProviderContext {
  userId: string;
  agentId?: string;
  /** Aborts the upstream request when the client disconnects. */
  signal?: AbortSignal;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** Which vendor's wire format `ProviderPayload.items` is shaped for. */
export type ProviderFormat = 'openai_responses' | 'anthropic_messages';

/**
 * A provider's own response, kept verbatim instead of translated into the
 * neutral shape.
 *
 * Reasoning items (OpenAI's encrypted `reasoning` blocks, Anthropic's
 * thinking blocks) don't survive a round trip through a shared
 * representation -- each vendor's replay format is its own. Carrying them as
 * opaque `items` under their own `format` tag lets the same adapter that
 * produced them replay them, without this package having to model what's
 * inside.
 */
export interface ProviderPayload {
  format: ProviderFormat;
  items: unknown[];
}

/** How hard the model should think before answering. */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /**
   * Pictures attached to a user message, as data URLs.
   *
   * Only meaningful on `role: 'user'`. A provider without vision ignores them
   * rather than failing, so a caller can always attach one and the worst case
   * is a model that answers from the words alone.
   *
   * Data URLs rather than links because the images this carries are files a
   * student just handed over -- they exist nowhere a model could fetch them
   * from, and putting them somewhere fetchable would mean hosting a student's
   * homework at a public address.
   */
  images?: string[];
  /** Set on `role: 'tool'` messages to pair a result with its call. */
  toolCallId?: string;
  /**
   * Set on `role: 'assistant'` messages that requested tools.
   *
   * Both OpenAI and Anthropic require the original tool call to be replayed in
   * the conversation before its result -- otherwise the result refers to
   * nothing and the request is rejected. Dropping these is the classic
   * multi-turn tool-calling bug, and it only shows up once a tool is actually
   * registered, which is exactly when it is hardest to notice.
   */
  toolCalls?: ToolCall[];
  /**
   * Assistant only: the provider's own output items, replayed verbatim by the
   * same wire format so its reasoning survives the round trip; a different
   * format ignores it.
   */
  payload?: ProviderPayload;
}

/**
 * Provider-neutral tool description.
 *
 * JSON Schema rather than a Zod type because this crosses the provider
 * boundary and every vendor speaks JSON Schema. packages/agent converts its
 * Zod schemas to this shape at the edge.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  /**
   * Let the provider search the web itself, server-side.
   *
   * Not a ToolDefinition, because the loop runs inside the one request: the
   * model searches, reads and cites without the caller ever seeing a tool call
   * to execute. Both vendors ship it, which is why it belongs on the neutral
   * interface rather than leaking a provider into a call site.
   *
   * `maxUses` is the bill. Searches are priced per search rather than per
   * token, so a pass that decides to keep looking is a cost nothing else in
   * this system can bound.
   */
  webSearch?: { maxUses?: number };
  /** Omitted means the adapter's default; the agent turn runs xhigh, a title needs none. */
  effort?: ReasoningEffort;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string from the provider. Always parse -- never string-match. */
  arguments: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prefix tokens served from the provider's cache, billed at a discount. */
  cachedInputTokens: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  /** The provider's own output items, to replay on the next turn. */
  payload?: ProviderPayload;
  /** Human-readable summary of the model's reasoning, when the provider offers one. */
  reasoningSummary?: string;
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'other';
}

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'done'; usage: TokenUsage; finishReason: ChatResponse['finishReason'] };
