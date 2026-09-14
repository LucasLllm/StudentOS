import { describe, expect, it, vi } from 'vitest';
import { OpenAiProvider, toResponsesInput, toolsFor } from './openai.js';
import type { ChatMessage } from '../types.js';

// The SDK is the boundary: capture what chat() hands it instead of dialling out.
const create = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));

/**
 * The Responses API request shape.
 *
 * Worth testing directly because getting it wrong produces a 400 that only
 * surfaces once a tool is registered -- which is exactly the corner that
 * shipped broken twice.
 */
describe('toResponsesInput', () => {
  it('lifts system messages into instructions', () => {
    const { instructions, input } = toResponsesInput([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);

    // Responses takes the system prompt top-level, not as an input item.
    expect(instructions).toBe('You are helpful.');
    expect(input).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('joins multiple system messages', () => {
    const { instructions } = toResponsesInput([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'hi' },
    ]);
    expect(instructions).toBe('A\n\nB');
  });

  it('omits instructions entirely when there is no system message', () => {
    expect(toResponsesInput([{ role: 'user', content: 'hi' }]).instructions).toBeUndefined();
  });

  /**
   * The multi-turn tool bug. A function_call_output whose matching
   * function_call was never replayed refers to nothing, and the API rejects
   * the whole request.
   */
  it('replays tool calls before their results', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'what is due this week?' },
      {
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [
          {
            id: 'call_abc',
            name: 'google_classroom_list_coursework',
            arguments: '{"courseId":"x"}',
          },
        ],
      },
      { role: 'tool', toolCallId: 'call_abc', content: '{"coursework":[]}' },
    ];

    expect(toResponsesInput(messages).input).toEqual([
      { role: 'user', content: 'what is due this week?' },
      { role: 'assistant', content: 'Let me check.' },
      {
        type: 'function_call',
        call_id: 'call_abc',
        name: 'google_classroom_list_coursework',
        arguments: '{"courseId":"x"}',
      },
      { type: 'function_call_output', call_id: 'call_abc', output: '{"coursework":[]}' },
    ]);
  });

  it('emits the call even when the assistant said nothing alongside it', () => {
    // Models frequently call a tool with no preamble. An empty text item would
    // be rejected, so it must be skipped rather than sent blank.
    const { input } = toResponsesInput([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'tool_a', arguments: '{}' }],
      },
    ]);

    expect(input).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'tool_a', arguments: '{}' },
    ]);
  });

  it('handles several tool calls in one turn', () => {
    const { input } = toResponsesInput([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'tool_a', arguments: '{}' },
          { id: 'c2', name: 'tool_b', arguments: '{"x":1}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: 'a' },
      { role: 'tool', toolCallId: 'c2', content: 'b' },
    ]);

    expect(input).toHaveLength(4);
    expect(input.filter((i) => 'type' in i && i.type === 'function_call')).toHaveLength(2);
  });

  it('keeps a plain assistant turn as a message', () => {
    const { input } = toResponsesInput([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ]);

    expect(input).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ]);
  });

  it('replays its own output items verbatim, reasoning included', () => {
    const items = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'vault_open',
        arguments: '{"name":"maths"}',
        status: 'completed',
      },
    ];
    const { input } = toResponsesInput([
      { role: 'user', content: 'open maths' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'vault_open', arguments: '{"name":"maths"}' }],
        payload: { format: 'openai_responses', items },
      },
      { role: 'tool', toolCallId: 'call_1', content: '{"body":"…"}' },
    ]);

    // The reasoning item is there, the call is there once, and the output follows it.
    expect(
      input.map((item) =>
        'type' in item ? (item as { type: string }).type : (item as { role: string }).role,
      ),
    ).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
    expect(input[1]).toMatchObject({ type: 'reasoning', encrypted_content: 'opaque' });
  });

  it('drops a stored item the installed SDK does not know and replays the rest', () => {
    // The transcript is append-only: one item from a newer API that this SDK
    // throws on would break every later replay of that chat forever.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { input } = toResponsesInput([
      { role: 'user', content: 'open maths' },
      {
        role: 'assistant',
        content: '',
        payload: {
          format: 'openai_responses',
          items: [
            { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
            { type: 'made_up_future_item', id: 'x_1' },
          ],
        },
      },
    ]);

    expect(
      input.map((item) =>
        'type' in item ? (item as { type: string }).type : (item as { role: string }).role,
      ),
    ).toEqual(['user', 'reasoning']);
    expect(warn).toHaveBeenCalledWith(
      'dropped unreplayable response items',
      expect.arrayContaining(['made_up_future_item']),
    );
    warn.mockRestore();
  });

  it('falls back to rebuilding the turn when the payload is another provider’s', () => {
    const { input } = toResponsesInput([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'Let me look.',
        toolCalls: [{ id: 'call_1', name: 'vault_open', arguments: '{}' }],
        payload: { format: 'anthropic_messages', items: [{ type: 'text', text: 'Let me look.' }] },
      },
      { role: 'tool', toolCallId: 'call_1', content: '{}' },
    ]);
    expect(
      input.map((item) =>
        'type' in item ? (item as { type: string }).type : (item as { role: string }).role,
      ),
    ).toEqual(['user', 'assistant', 'function_call', 'function_call_output']);
  });
});

describe('the tools OpenAI receives', () => {
  const request = (over = {}) => ({
    messages: [{ role: 'user' as const, content: 'hi' }],
    ...over,
  });

  it('sends nothing when there is nothing to send', () => {
    expect(toolsFor(request())).toBeUndefined();
  });

  it('does not offer web search unless it is asked for', () => {
    const tools = toolsFor(
      request({ tools: [{ name: 'vault_open', description: 'Open a page', parameters: {} }] }),
    );

    expect(tools?.map((tool) => tool.type)).toEqual(['function']);
  });

  it('adds the provider’s own search when a pass asks to research', () => {
    expect(toolsFor(request({ webSearch: {} }))).toEqual([{ type: 'web_search' }]);
  });

  it('keeps the caller’s own tools alongside it', () => {
    const tools = toolsFor(
      request({
        tools: [{ name: 'vault_open', description: 'Open a page', parameters: {} }],
        webSearch: {},
      }),
    );

    expect(tools?.map((tool) => tool.type)).toEqual(['function', 'web_search']);
  });
});

describe('the reasoning OpenAI is asked for', () => {
  it('runs every turn at xhigh effort', async () => {
    create.mockResolvedValueOnce({ output: [], output_text: '', status: 'completed' });
    const provider = new OpenAiProvider({ apiKey: 'k', model: 'gpt-5.6-luna' });

    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] }, { userId: 'u1' });

    expect(create.mock.calls[0]?.[0]).toMatchObject({ reasoning: { effort: 'xhigh' } });
  });
});

describe('what OpenAI is asked for', () => {
  const provider = () => new OpenAiProvider({ apiKey: 'k', model: 'gpt-5.6-luna' });
  const empty = { output: [], output_text: '', status: 'completed' };

  it('keeps reasoning across turns and asks for its summary', async () => {
    create.mockResolvedValueOnce(empty);
    await provider().chat({ messages: [{ role: 'user', content: 'hi' }] }, { userId: 'u1' });
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({
      reasoning: { effort: 'xhigh', context: 'all_turns', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
    });
  });

  it('lets a caller lower the effort', async () => {
    create.mockResolvedValueOnce(empty);
    await provider().chat(
      { messages: [{ role: 'user', content: 'hi' }], effort: 'low' },
      { userId: 'u1' },
    );
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({ reasoning: { effort: 'low' } });
  });

  it('always caps output, and lets a caller choose the cap', async () => {
    create.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty);
    await provider().chat({ messages: [{ role: 'user', content: 'hi' }] }, { userId: 'u1' });
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({ max_output_tokens: 32_000 });
    await provider().chat(
      { messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 200 },
      { userId: 'u1' },
    );
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({ max_output_tokens: 200 });
  });

  it('routes the cache by conversation', async () => {
    create.mockResolvedValueOnce(empty);
    await provider().chat(
      { messages: [{ role: 'user', content: 'hi' }] },
      { userId: 'u1', agentId: 'agent-7' },
    );
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({ prompt_cache_key: 'agent-7' });
  });

  it('hands back the raw output items and the reasoning summary', async () => {
    const output = [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Checking the dates.' }],
        encrypted_content: 'opaque',
      },
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [] },
    ];
    create.mockResolvedValueOnce({ output, output_text: 'done', status: 'completed' });
    const response = await provider().chat(
      { messages: [{ role: 'user', content: 'hi' }] },
      { userId: 'u1' },
    );
    expect(response.payload).toEqual({ format: 'openai_responses', items: output });
    expect(response.reasoningSummary).toBe('Checking the dates.');
  });
});
