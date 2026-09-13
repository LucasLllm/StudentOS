import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { ResponseInputItemLike } from 'openai/lib/responses/ResponseInputItems';
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LlmProvider,
  ProviderContext,
  ToolCall,
} from '../types.js';

/**
 * Reasoning tokens count against this. xhigh on a hard step can spend 10-20k
 * before a word of the answer; Luna allows 128k. Below this the answer is cut
 * mid-thought and comes back as status 'incomplete' with no text.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  /** 'openai' for a student's own key, 'platform' for ours. */
  id?: 'openai' | 'platform';
}

/**
 * OpenAI adapter, on the Responses API.
 *
 * Backs both the BYOK path and the platform tier -- same wire protocol, only
 * the key and model differ -- which is why this package has one vendor SDK
 * instead of two.
 *
 * Uses /v1/responses rather than /v1/chat/completions because the reasoning
 * models reject the combination of function tools and reasoning on chat
 * completions:
 *
 *   400 Function tools with reasoning_effort are not supported for
 *       gpt-5.6-luna in /v1/chat/completions.
 *
 * The alternative was reasoning_effort: 'none', which keeps chat completions
 * working but turns off the reasoning an agent doing multi-step tool use most
 * needs. Responses is also where OpenAI is putting new capability.
 *
 * Requests the reasoning items back encrypted (`include:
 * ['reasoning.encrypted_content']`) and replays them on the next turn via
 * `payload`, rather than storing anything server-side (`store: false`): we
 * hold the transcript ourselves, so nothing of a student's chat is retained
 * by OpenAI, but the model still gets its own prior reasoning back instead of
 * starting each turn cold.
 */
export class OpenAiProvider implements LlmProvider {
  readonly id: 'openai' | 'platform';
  readonly model: string;
  readonly #client: OpenAI;

  constructor({ apiKey, model, id = 'openai' }: OpenAiProviderOptions) {
    this.id = id;
    this.model = model;
    this.#client = new OpenAI({ apiKey });
  }

  async chat(request: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> {
    const { instructions, input } = toResponsesInput(request.messages);

    const response = await this.#client.responses.create(
      {
        model: this.model,
        // context: all_turns renders the reasoning items replayed from earlier
        // turns back into the model's context -- the gpt-5.6 default, stated so
        // it cannot silently change. summary: auto is what the activity feed
        // can show. Both are no-ops unless the items are actually replayed.
        reasoning: { effort: request.effort ?? 'xhigh', context: 'all_turns', summary: 'auto' },
        // We hold the transcript; nothing of a student's chat is retained
        // server-side. Encrypted reasoning is what makes replay possible without
        // storage.
        include: ['reasoning.encrypted_content'],
        store: false,
        ...(ctx.agentId ? { prompt_cache_key: ctx.agentId } : {}),
        input,
        ...(instructions ? { instructions } : {}),
        max_output_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        ...(toolsFor(request) ? { tools: toolsFor(request) } : {}),
      },
      { signal: ctx.signal },
    );

    const toolCalls: ToolCall[] = response.output
      .filter((item) => item.type === 'function_call')
      .map((item) => ({
        // call_id, not id: call_id is what a function_call_output must echo.
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      }));

    const usageDetails = response.usage?.input_tokens_details as
      { cached_tokens?: number } | undefined;

    const reasoningSummary = response.output
      .filter((item) => item.type === 'reasoning')
      .flatMap((item) => item.summary.map((part) => part.text))
      .join('\n');

    return {
      content: response.output_text,
      toolCalls,
      payload: { format: 'openai_responses', items: response.output },
      ...(reasoningSummary ? { reasoningSummary } : {}),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cachedInputTokens: usageDetails?.cached_tokens ?? 0,
      },
      finishReason:
        toolCalls.length > 0 ? 'tool_calls' : response.status === 'incomplete' ? 'length' : 'stop',
    };
  }

  /**
   * Streaming.
   *
   * Deliberately delegates to chat() and emits the finished answer as one
   * chunk. Nothing consumes streaming yet, and shipping a second, untested
   * request path -- with its own tool-call reassembly -- is how the tool-name
   * and reasoning bugs got to production in the first place.
   *
   * TODO(streaming): implement properly with client.responses.stream() when a
   * route actually streams, and test the delta reassembly against a real call.
   */
  async *stream(request: ChatRequest, ctx: ProviderContext): AsyncIterable<ChatChunk> {
    const response = await this.chat(request, ctx);
    if (response.content) {
      yield { type: 'text', text: response.content };
    }
    yield { type: 'done', usage: response.usage, finishReason: response.finishReason };
  }
}

/**
 * The tools a request carries, the caller's own and the provider's.
 *
 * Flat shape on Responses -- name/description/parameters sit at the top level,
 * not nested under `function` as on chat completions.
 *
 * Web search is OpenAI's own, run server-side: the model searches and reads
 * inside the one request, and the result arrives as `web_search_call` output
 * items rather than as a `function_call` for the caller to execute. So the
 * tool-call extraction above, which filters on `function_call`, cannot pick one
 * up and try to run it.
 */
export function toolsFor(request: ChatRequest): OpenAI.Responses.Tool[] | undefined {
  const tools: OpenAI.Responses.Tool[] = (request.tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
    strict: false,
  }));

  if (request.webSearch) tools.push({ type: 'web_search' });

  return tools.length > 0 ? tools : undefined;
}

/**
 * Convert provider-neutral messages into a Responses API request.
 *
 * Exported for tests: getting this shape wrong produces a 400 that only
 * appears once tools are in play, so it is worth asserting directly rather
 * than discovering in production.
 */
export function toResponsesInput(messages: ChatMessage[]): {
  instructions: string | undefined;
  input: OpenAI.Responses.ResponseInput;
} {
  const systemParts: string[] = [];
  const input: OpenAI.Responses.ResponseInput = [];

  for (const message of messages) {
    if (message.role === 'system') {
      // Responses takes the system prompt as top-level `instructions`.
      systemParts.push(message.content);
      continue;
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: message.content,
      });
      continue;
    }

    if (message.role === 'assistant') {
      /*
       * The provider's own items, sent back exactly as it produced them.
       *
       * This is what carries the reasoning: the model continues the chain of
       * thought it had going instead of rebuilding its plan from the text alone.
       * The SDK helper strips the fields the API refuses on input. Only a payload
       * in this wire format is replayable; anything else rebuilds the turn below.
       */
      if (message.payload?.format === 'openai_responses') {
        input.push(...toResponseInputItems(message.payload.items as ResponseInputItemLike[]));
        continue;
      }
      if (message.content) {
        input.push({ role: 'assistant', content: message.content });
      }
      // Replay the calls themselves. Without these, the function_call_output
      // that follows refers to a call the model never sees and is rejected.
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      continue;
    }

    /*
     * A user message carrying pictures becomes a list of parts rather than a
     * string. The text still goes first: it is the question, and the images
     * are what it is about.
     */
    if (message.images && message.images.length > 0) {
      input.push({
        role: 'user',
        content: [
          { type: 'input_text', text: message.content },
          ...message.images.map((url) => ({
            type: 'input_image' as const,
            image_url: url,
            detail: 'auto' as const,
          })),
        ],
      });
      continue;
    }

    input.push({ role: 'user', content: message.content });
  }

  return {
    instructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    input,
  };
}
