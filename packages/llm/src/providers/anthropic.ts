import Anthropic from '@anthropic-ai/sdk';
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
 * Default when a student brings an Anthropic key without naming a model.
 *
 * Not Fable 5.1, deliberately. Clearing replays a stub in place of a tool
 * result and compaction replays a summary in place of the turns it covers --
 * both are edits to replayed history, which Fable 5.1 (and later models for
 * everyone) rejects when thinking blocks are replayed alongside them, since
 * preserved thinking has to match the turn it belongs to. Moving this default
 * forward needs a format-aware render first, e.g. one that drops thinking
 * blocks from edited turns. See transcript/render.ts.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
}

/**
 * Anthropic adapter for the BYOK path.
 *
 * Two shape differences from OpenAI that this class absorbs so call sites never
 * see them: the system prompt is a top-level field rather than a message, and
 * tool results are content blocks inside a user turn rather than their own role.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly model: string;
  readonly #client: Anthropic;

  constructor({ apiKey, model = DEFAULT_ANTHROPIC_MODEL }: AnthropicProviderOptions) {
    this.model = model;
    this.#client = new Anthropic({ apiKey });
  }

  async chat(request: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> {
    const { system, messages } = splitSystem(request.messages);

    const response = await this.#client.messages.create(
      {
        model: this.model,
        // Caps thinking + visible output together. Opus 5 thinks by default,
        // so a value tuned for a non-thinking model will truncate answers.
        max_tokens: request.maxOutputTokens ?? 16_000,
        // Adaptive thinking, unless the caller wants none (a title). Effort maps
        // straight through; Anthropic's ladder has the same rungs.
        ...(request.effort === 'none' ? {} : { thinking: { type: 'adaptive' } }),
        ...(request.effort && request.effort !== 'none'
          ? { output_config: { effort: request.effort } }
          : {}),
        system,
        messages,
        tools: toolsFor(request),
      },
      { signal: ctx.signal },
    );

    // Safety classifiers can decline with HTTP 200 and empty content. Reading
    // content[0] without this check throws on a refusal.
    if (response.stop_reason === 'refusal') {
      return {
        content: '',
        toolCalls: [],
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
        },
        finishReason: 'other',
      };
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const toolCalls: ToolCall[] = response.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      }));

    const reasoningSummary = response.content
      .filter((block) => block.type === 'thinking')
      .map((block) => block.thinking)
      .join('\n');

    return {
      content: text,
      toolCalls,
      payload: { format: 'anthropic_messages', items: response.content },
      ...(reasoningSummary ? { reasoningSummary } : {}),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      },
      finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    };
  }

  async *stream(request: ChatRequest, ctx: ProviderContext): AsyncIterable<ChatChunk> {
    const { system, messages } = splitSystem(request.messages);

    const stream = this.#client.messages.stream(
      {
        model: this.model,
        max_tokens: request.maxOutputTokens ?? 16_000,
        system,
        messages,
      },
      { signal: ctx.signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();
    yield {
      type: 'done',
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cachedInputTokens: final.usage.cache_read_input_tokens ?? 0,
      },
      finishReason: final.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    };
  }
}

/**
 * The tools a request carries, the caller's own and the provider's.
 *
 * Web search is Anthropic's, run server-side: the model searches and reads
 * inside the one request and answers with what it found, so nothing here has to
 * execute anything. It arrives as `server_tool_use` blocks, which is a
 * different block type from `tool_use` -- so the tool-call extraction above
 * cannot mistake one for the other and try to run it.
 *
 * Undefined rather than an empty array when there is nothing: some providers
 * reject a zero-length tools array, and until OAuth exists no student has any.
 */
export function toolsFor(request: ChatRequest): Anthropic.ToolUnion[] | undefined {
  const tools: Anthropic.ToolUnion[] = (request.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }));

  if (request.webSearch) {
    tools.push({
      type: 'web_search_20260318',
      name: 'web_search',
      // Priced per search. Left unbounded, a pass that decides to keep looking
      // is the one cost in this system nothing else can cap.
      max_uses: request.webSearch.maxUses ?? 8,
    });
  }

  return tools.length > 0 ? tools : undefined;
}

/**
 * Anthropic takes the system prompt as a top-level field, not a message.
 *
 * It comes back as a block array rather than a string so the last block can
 * carry a cache breakpoint. Anthropic caches nothing without one -- unlike
 * OpenAI, where prefix caching is automatic -- and the omission is invisible:
 * the request succeeds, the answer is fine, and `cache_read_input_tokens`
 * comes back as zero forever. Reading that as "this student's prompt does not
 * cache well" rather than "we never asked" is the trap this closes.
 *
 * The breakpoint sits at the end of the system prompt because Anthropic orders
 * the cacheable prefix tools, then system, then messages -- so one breakpoint
 * here covers both the tool schemas and everything buildSystemPrompt
 * assembled. Below the minimum cacheable length the breakpoint is ignored
 * rather than rejected, so there is nothing to guard.
 *
 * Exported for tests: a breakpoint that silently stops being sent costs money
 * without failing anything.
 */
export function splitSystem(messages: ChatMessage[]): {
  system: Anthropic.TextBlockParam[] | undefined;
  messages: Anthropic.MessageParam[];
} {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m): Anthropic.MessageParam => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
        };
      }

      if (m.role === 'assistant' && m.payload?.format === 'anthropic_messages') {
        // Thinking blocks carry a signature the API checks on replay; sending the
        // blocks back untouched is the only way the thinking survives.
        return { role: 'assistant', content: m.payload.items as Anthropic.ContentBlockParam[] };
      }

      // An assistant turn that called tools must replay those tool_use blocks,
      // or the tool_result that follows references a call Anthropic never sees
      // and the request is rejected.
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const call of m.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            // Anthropic wants the parsed object; the neutral shape carries the
            // raw JSON string every provider emits.
            input: JSON.parse(call.arguments) as Record<string, unknown>,
          });
        }
        return { role: 'assistant', content: blocks };
      }

      return { role: m.role, content: m.content };
    });

  return {
    system:
      systemParts.length > 0
        ? [
            {
              type: 'text',
              text: systemParts.join('\n\n'),
              cache_control: { type: 'ephemeral' },
            },
          ]
        : undefined,
    messages: rest,
  };
}
