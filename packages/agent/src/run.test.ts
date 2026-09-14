import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, currentTimeSection, runAgentTurn } from './run.js';
import { COMPACTION, RESPONDING, VAULT_READING, WORKING } from './prompts/documents.js';
import { ToolRegistry } from './tools/registry.js';
import { loadSkill } from './tools/skills.js';
import { InMemoryTranscriptStore } from './transcript/in-memory.js';
import { COMPACTION_HANDOFF } from './transcript/render.js';
import type { AgentPlan } from './plan/types.js';
import type { ToolContext } from './tools/types.js';
import type { AgentRunDeps } from './run.js';

const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };

/** Everything a turn needs, with a transcript of its own to talk into. */
function depsWith(chat: (request: unknown) => Promise<unknown>, tools = new ToolRegistry()) {
  return {
    llm: { chat },
    memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
    skills: { list: async () => [] },
    tools,
    transcript: new InMemoryTranscriptStore(),
  } as unknown as AgentRunDeps;
}

/**
 * Temporal grounding.
 *
 * A model has no clock. Without this the agent cannot turn "tomorrow at 3pm"
 * into an ISO timestamp, so it interrogates the student instead of acting --
 * which is what it did on the first live write attempt.
 */
describe('currentTimeSection', () => {
  const noon = new Date('2026-08-14T16:00:00Z');

  it('states the local time and the offset', () => {
    const section = currentTimeSection('America/New_York', noon);

    expect(section).toContain('America/New_York');
    // 16:00 UTC is 12:00 EDT.
    expect(section).toContain('12:00');
    // The offset is what makes a valid ISO string possible; a zone name alone
    // is not enough, and it shifts with daylight saving.
    expect(section).toContain('GMT-04:00');
  });

  it('reflects daylight saving rather than a fixed offset', () => {
    const winter = new Date('2026-01-14T16:00:00Z');
    expect(currentTimeSection('America/New_York', winter)).toContain('GMT-05:00');
    expect(currentTimeSection('America/New_York', noon)).toContain('GMT-04:00');
  });

  it('falls back to UTC when no timezone is known', () => {
    const section = currentTimeSection(undefined, noon);
    expect(section).toContain('UTC');
  });

  it('tells the agent not to ask', () => {
    // The behaviour being fixed: the agent asked "what timezone?" instead of
    // creating the event.
    expect(currentTimeSection('Europe/London', noon)).toMatch(/do not ask/i);
  });

  it('survives a bogus timezone instead of throwing', () => {
    // A bad value must not take down every turn for that student.
    const section = currentTimeSection('Not/AZone', noon);
    expect(section).toContain('UTC');
    expect(section).toContain('2026-08-14');
  });

  it('gets the date right across a day boundary', () => {
    // 23:30 UTC is already the next day in Tokyo. Getting this wrong schedules
    // everything a day off.
    const lateUtc = new Date('2026-08-14T23:30:00Z');
    expect(currentTimeSection('Asia/Tokyo', lateUtc)).toContain('15 August 2026');
    expect(currentTimeSection('UTC', lateUtc)).toContain('14 August 2026');
  });
});

/**
 * Capability plumbing.
 *
 * The regression this exists for: AgentRunInput accepted a transcriber and
 * runAgentTurn never forwarded it, so every video reported "transcription
 * isn't configured" on a server where it was. The seam existed and stopped
 * one layer short -- invisible to every other test, because they exercise the
 * tools directly and build the context themselves.
 */
describe('tool context', () => {
  /** Answers one tool call, then replies. Enough to reach a tool. */
  function llmCallingProbe() {
    let turn = 0;
    return {
      async chat() {
        turn += 1;
        const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
        return turn === 1
          ? {
              content: '',
              toolCalls: [{ id: 'c1', name: 'probe', arguments: '{}' }],
              usage,
              finishReason: 'tool_calls' as const,
            }
          : { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
      },
    };
  }

  it('forwards every optional capability to the tool', async () => {
    const seen: ToolContext[] = [];
    const tools = new ToolRegistry();
    tools.register({
      id: 'probe',
      description: 'records the context it receives',
      inputSchema: z.object({}),
      execute: async (_input: Record<string, never>, ctx: ToolContext) => {
        seen.push(ctx);
        return 'ok';
      },
    } as never);

    const google = { getAccessToken: async () => 'token', hasScope: () => true };
    const transcriber = { transcribe: async () => 'words' };

    const deps = {
      llm: llmCallingProbe(),
      memory: {
        recall: async () => ({ summaries: [], recent: [] }),
        record: async () => ({}),
      },
      skills: { list: async () => [] },
      tools,
      transcript: new InMemoryTranscriptStore(),
    } as unknown as AgentRunDeps;

    await runAgentTurn(deps, {
      userId: 'u1',
      agentId: 'a1',
      purpose: 'test',
      message: 'go',
      google,
      transcriber,
    } as never);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.google).toBe(google);
    expect(seen[0]?.transcriber).toBe(transcriber);
  });
});

/**
 * A turn always says something.
 *
 * A model that does its work and then returns no text leaves an empty bubble
 * in the conversation -- the browser visibly went and read a page, and the
 * student is told nothing at all about what it found. Whatever else happens,
 * a turn owes the student a sentence.
 */
describe('always answering', () => {
  const deps = (chat: () => Promise<unknown>) =>
    ({
      llm: { chat },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools: new ToolRegistry(),
      transcript: new InMemoryTranscriptStore(),
    }) as unknown as AgentRunDeps;

  const input = { userId: 'u1', agentId: 'a1', purpose: 'test', message: 'go' } as never;
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

  it('says something even when the model returns nothing at all', async () => {
    const { reply } = await runAgentTurn(
      deps(async () => ({ content: '', toolCalls: [], usage, finishReason: 'stop' as const })),
      input,
    );
    expect(reply.trim()).not.toBe('');
  });

  it('says something when the model returns only whitespace', async () => {
    const { reply } = await runAgentTurn(
      deps(async () => ({
        content: '   \n  ',
        toolCalls: [],
        usage,
        finishReason: 'stop' as const,
      })),
      input,
    );
    expect(reply.trim()).not.toBe('');
  });

  it('leaves a real answer exactly as the model wrote it', async () => {
    const { reply } = await runAgentTurn(
      deps(async () => ({
        content: 'Dogs live 10-13 years.',
        toolCalls: [],
        usage,
        finishReason: 'stop' as const,
      })),
      input,
    );
    expect(reply).toBe('Dogs live 10-13 years.');
  });

  it('mentions what it did when it has nothing else to say', async () => {
    // It drove a browser and then went quiet: the fallback should at least
    // account for the work the student watched happen.
    const tools = new ToolRegistry();
    tools.register({
      id: 'browser_open',
      description: 'opens a page',
      inputSchema: z.object({}),
      execute: async () => 'page text',
    } as never);

    let turn = 0;
    const chat = async () => {
      turn += 1;
      return turn === 1
        ? {
            content: '',
            toolCalls: [{ id: 'c1', name: 'browser_open', arguments: '{}' }],
            usage,
            finishReason: 'tool_calls' as const,
          }
        : { content: '', toolCalls: [], usage, finishReason: 'stop' as const };
    };

    const runDeps = {
      llm: { chat },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools,
      transcript: new InMemoryTranscriptStore(),
    } as unknown as AgentRunDeps;

    const { reply } = await runAgentTurn(runDeps, input);
    expect(reply).toMatch(/browser_open/);
  });
});

/**
 * A model that returns no text field at all.
 *
 * Not hypothetical: the OpenAI adapter passes `output_text` straight through,
 * and a response carrying no text has no such field. That is the very case
 * the fallback above exists for -- so reaching it must not be what breaks.
 * Calling .trim() on it threw a TypeError, which took the whole turn down and
 * left the student with nothing at all rather than with the fallback.
 */
describe('a reply with no text field', () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const input = { userId: 'u1', agentId: 'a1', purpose: 'test', message: 'go' } as never;
  const deps = (chat: () => Promise<unknown>) =>
    ({
      llm: { chat },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools: new ToolRegistry(),
      transcript: new InMemoryTranscriptStore(),
    }) as unknown as AgentRunDeps;

  it('does not throw when content is missing entirely', async () => {
    const { reply } = await runAgentTurn(
      deps(async () => ({ toolCalls: [], usage, finishReason: 'stop' as const })),
      input,
    );
    expect(reply.trim()).not.toBe('');
  });

  it('does not throw when content is null', async () => {
    const { reply } = await runAgentTurn(
      deps(async () => ({ content: null, toolCalls: [], usage, finishReason: 'stop' as const })),
      input,
    );
    expect(reply.trim()).not.toBe('');
  });
});

/**
 * Saying what it is doing, while it does it.
 *
 * A turn that calls tools can run for a minute, and until now the only thing
 * the student could be told was that something was happening. The loop knows
 * far more than that -- which tool it is about to run, and when it has gone
 * back to the model -- and reporting it is what lets the conversation name the
 * work instead of spinning.
 *
 * A notification, not a hook: whatever the caller does with it, the turn runs
 * exactly as it would have.
 */
describe('reporting activity', () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

  function depsCalling(toolIds: string[]) {
    const tools = new ToolRegistry();
    for (const id of toolIds) {
      tools.register({
        id,
        description: 'a tool',
        inputSchema: z.object({}),
        execute: async () => 'ok',
      } as never);
    }
    let turn = 0;
    return {
      llm: {
        async chat() {
          turn += 1;
          return turn === 1
            ? {
                content: '',
                toolCalls: toolIds.map((name, i) => ({ id: `c${i}`, name, arguments: '{}' })),
                usage,
                finishReason: 'tool_calls' as const,
              }
            : { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
        },
      },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools,
      transcript: new InMemoryTranscriptStore(),
    } as unknown as AgentRunDeps;
  }

  const input = (onActivity: unknown) =>
    ({ userId: 'u1', agentId: 'a1', purpose: 'test', message: 'go', onActivity }) as never;

  it('says it is thinking before it asks the model', async () => {
    const seen: unknown[] = [];
    await runAgentTurn(
      depsCalling([]),
      input((a: unknown) => seen.push(a)),
    );

    expect(seen[0]).toEqual({ kind: 'thinking' });
  });

  it('names each tool before running it', async () => {
    const seen: unknown[] = [];
    await runAgentTurn(
      depsCalling(['google_classroom_list_courses']),
      input((a: unknown) => seen.push(a)),
    );

    expect(seen).toContainEqual({ kind: 'tool', name: 'google_classroom_list_courses' });
  });

  it('reports tools in the order the model asked for them', async () => {
    const seen: string[] = [];
    await runAgentTurn(
      depsCalling(['gmail_search', 'google_drive_list']),
      input((a: { kind: string; name?: string }) => {
        if (a.kind === 'tool' && a.name) seen.push(a.name);
      }),
    );

    expect(seen).toEqual(['gmail_search', 'google_drive_list']);
  });

  it('goes back to thinking after the tools have run', async () => {
    // The student watched it read their mail; what follows is the model
    // working out what to say about it, and saying so is the honest report.
    const seen: string[] = [];
    await runAgentTurn(
      depsCalling(['gmail_search']),
      input((a: { kind: string }) => seen.push(a.kind)),
    );

    expect(seen).toEqual(['thinking', 'tool', 'thinking']);
  });

  it('runs the turn normally when nobody is listening', async () => {
    const { reply } = await runAgentTurn(depsCalling(['gmail_search']), input(undefined));
    expect(reply).toBe('done');
  });
});

/**
 * Reading a skill is its own kind of step.
 *
 * A student watching the line under their question is owed "reading the
 * browser skill", not "running skill_load": the skill is the thing they can
 * recognise. It is also what stays on the transcript once the answer lands,
 * so the turn hands the names back beside the reply.
 */
describe('reporting a skill', () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

  /** Asks for each named skill in one round, then replies. */
  function depsLoading(names: string[]) {
    const tools = new ToolRegistry();
    tools.register(loadSkill as never);
    let turn = 0;
    return {
      llm: {
        async chat() {
          turn += 1;
          return turn === 1
            ? {
                content: '',
                toolCalls: names.map((name, i) => ({
                  id: `c${i}`,
                  name: 'skill_load',
                  arguments: JSON.stringify({ name }),
                })),
                usage,
                finishReason: 'tool_calls' as const,
              }
            : { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
        },
      },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools,
      transcript: new InMemoryTranscriptStore(),
    } as unknown as AgentRunDeps;
  }

  const input = (onActivity: unknown) =>
    ({ userId: 'u1', agentId: 'a1', purpose: 'test', message: 'go', onActivity }) as never;

  it('names the skill before reading it, rather than the tool that reads it', async () => {
    const seen: unknown[] = [];
    await runAgentTurn(
      depsLoading(['browser']),
      input((a: unknown) => seen.push(a)),
    );

    expect(seen).toEqual([
      { kind: 'thinking' },
      { kind: 'skill', name: 'browser' },
      { kind: 'thinking' },
    ]);
  });

  it('hands back which skills it read, beside the reply', async () => {
    const result = await runAgentTurn(depsLoading(['browser']), input(undefined));
    expect(result.skillsRead).toEqual(['browser']);
  });

  it('names a skill once however many times the model asked for it', async () => {
    const result = await runAgentTurn(depsLoading(['browser', 'browser']), input(undefined));
    expect(result.skillsRead).toEqual(['browser']);
  });

  it('does not claim to have read a skill that does not exist', async () => {
    // The tool answers with the list of real ones and the model tries again.
    // The student must not be told the agent read something it never had.
    const seen: unknown[] = [];
    const result = await runAgentTurn(
      depsLoading(['nonsense']),
      input((a: unknown) => seen.push(a)),
    );

    expect(seen).toContainEqual({ kind: 'tool', name: 'skill_load' });
    expect(result.skillsRead).toEqual([]);
  });

  it('does not claim to have read a skill this student cannot use', async () => {
    // No vault here, so the vault skills answer "not available" and no body.
    const result = await runAgentTurn(depsLoading(['vault-reading']), input(undefined));
    expect(result.skillsRead).toEqual([]);
  });
});

/**
 * The prompt documents actually reach the model.
 *
 * buildSystemPrompt is exported for the evals and tests that call it
 * directly; nothing else would notice a section being dropped from what it
 * assembles. The document could be perfect, tested, and never sent.
 */
describe('the assembled system prompt', () => {
  /** Records the messages the turn sends, then replies. */
  function capturing(seen: { role: string; content: string }[]) {
    return depsWith(async (request) => {
      seen.push(...(request as { messages: { role: string; content: string }[] }).messages);
      return {
        content: 'done',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop' as const,
      };
    });
  }

  async function messagesFor(about?: string): Promise<{ role: string; content: string }[]> {
    const seen: { role: string; content: string }[] = [];
    await runAgentTurn(capturing(seen), {
      userId: 'u1',
      agentId: 'a1',
      purpose: 'keep me on top of chemistry',
      message: 'go',
      timezone: 'Europe/London',
      ...(about === undefined ? {} : { about }),
    } as never);
    return seen;
  }

  async function systemPrompt(about?: string): Promise<string> {
    return (await messagesFor(about)).find((m) => m.role === 'system')?.content ?? '';
  }

  async function userMessage(): Promise<string> {
    return (await messagesFor()).find((m) => m.role === 'user')?.content ?? '';
  }

  it('carries the responding document', async () => {
    expect(await systemPrompt()).toContain(RESPONDING.body);
  });

  /** The same prompt, for an agent created with the given purpose. */
  async function promptForPurpose(purpose: string): Promise<string> {
    const seen: { role: string; content: string }[] = [];
    await runAgentTurn(capturing(seen), {
      userId: 'u1',
      agentId: 'a1',
      purpose,
      message: 'go',
      timezone: 'Europe/London',
    } as never);
    return seen.find((m) => m.role === 'system')?.content ?? '';
  }

  /**
   * What the student attached reaches the model on the turn they attached it.
   *
   * The bug this pins was the whole image feature failing at its last step: a
   * photograph was read, transcribed and filed in the vault, and then the
   * agent answered "I cannot see images" -- because nothing put the
   * transcription in front of it, and "what is this" gives vault_search
   * nothing to search for.
   */
  async function turnWith(attachments: { name: string; body: string }[]): Promise<string> {
    const seen: { role: string; content: string }[] = [];
    await runAgentTurn(capturing(seen), {
      userId: 'u1',
      agentId: 'a1',
      purpose: 'help',
      message: 'what is this',
      timezone: 'Europe/London',
      attachments,
    } as never);
    return seen.find((m) => m.role === 'user')?.content ?? '';
  }

  it('carries what the student attached, contents and all', async () => {
    const turn = await turnWith([
      { name: 'board', body: '## What is in it\n\nA brass push-fit pneumatic connector.' },
    ]);

    expect(turn).toContain('brass push-fit pneumatic connector');
    expect(turn).toContain('board');
  });

  it('says nothing about attachments when there are none', async () => {
    expect(await turnWith([])).not.toContain('attached to this message');
  });

  it('keeps them in the turn rather than the system prompt', async () => {
    // The system prompt has to stay byte-identical between turns or nothing in
    // it caches, ever. A file attached to one message must not land there.
    const seen: { role: string; content: string }[] = [];
    await runAgentTurn(capturing(seen), {
      userId: 'u1',
      agentId: 'a1',
      purpose: 'help',
      message: 'what is this',
      timezone: 'Europe/London',
      attachments: [{ name: 'board', body: 'A connector.' }],
    } as never);

    expect(seen.find((m) => m.role === 'system')?.content ?? '').not.toContain('A connector.');
  });

  it('states the purpose when the student wrote one', async () => {
    expect(await promptForPurpose('keep me on top of chemistry')).toContain(
      'Your purpose, in their words: keep me on top of chemistry',
    );
  });

  /*
   * A chat started from a message has no purpose behind it, and the label
   * printed with nothing after it is worse than its absence: it tells the
   * model an answer belongs here and that it is empty, which reads as a
   * student who wants nothing.
   */
  it('says nothing about purpose when there is none', async () => {
    for (const blank of ['', '   ', '\n']) {
      expect(await promptForPurpose(blank)).not.toContain('Your purpose');
    }
  });

  /*
   * The property the whole prompt layout exists to protect.
   *
   * On the Responses API the system prompt is cached as a whole blob keyed on
   * its exact text -- appending six tokens to a 3,613-token prompt measured
   * `cached_tokens` dropping from 3,610 to zero. So a system prompt containing
   * a clock, or anything else that moves, does not cache partially. It does
   * not cache at all, on any turn, forever.
   *
   * A comment asking future editors to keep volatile text out cannot fail.
   * These can.
   */
  it('keeps the clock out of the system prompt', async () => {
    const prompt = await systemPrompt();
    expect(prompt).not.toContain('Right now it is');
  });

  it('sends a byte-identical system prompt as the conversation grows', async () => {
    // The point of the whole layout: what moves lives in the message list, so
    // the prompt above it stays cacheable however long the conversation gets.
    const seen: { role: string; content: string }[] = [];
    const deps = capturing(seen);
    const turn = {
      userId: 'u1',
      agentId: 'a1',
      purpose: 'keep me on top of chemistry',
      message: 'go',
      timezone: 'Europe/London',
    } as never;

    await runAgentTurn(deps, turn);
    await runAgentTurn(deps, turn);

    const prompts = seen.filter((m) => m.role === 'system');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.content).toBe(prompts[0]?.content);
  });

  it('still gives the model the clock, in the turn instead', async () => {
    // Moving it must not lose it: an agent that cannot resolve "tomorrow"
    // is broken in a way no caching win would justify.
    const user = await userMessage();
    expect(user).toContain('Right now it is');
    expect(user).toContain('Their timezone is');
  });

  it('marks the context off from what the student actually typed', async () => {
    // It rides in the user message, so without a boundary the model reads the
    // clock as something the student wrote.
    const user = await userMessage();
    expect(user).toMatch(/<turn_context>[\s\S]*<\/turn_context>/);
    expect(user.indexOf('</turn_context>')).toBeLessThan(user.indexOf('go'));
  });

  it('carries the page the vault writes about the student', async () => {
    const prompt = await systemPrompt('# Lucas\n\n- [[class-french]] — taught by Mme Rivard');
    expect(prompt).toContain('[[class-french]]');
    expect(prompt).toMatch(/what their vault says about them/i);
  });

  it('keeps that page above everything volatile, so it stays cached', async () => {
    // It is rewritten between conversations at most, which makes it per-agent
    // rather than per-turn -- the tier that still caches.
    const prompt = await systemPrompt('# Lucas');
    expect(prompt.indexOf('# Lucas')).toBeGreaterThan(-1);
    expect(prompt).not.toContain('Right now it is');
  });

  it('carries no heading at all for a student nothing has been written about', async () => {
    // An empty section would cost tokens in the cached prefix on every turn
    // of every conversation, for every new student, forever.
    expect(await systemPrompt('')).not.toMatch(/what their vault says about them/i);
  });

  it('no longer carries a second, per-agent document about the same student', async () => {
    /*
     * There used to be two: this page, and a conversation profile belonging to
     * one agent. The split was wrong rather than merely wasteful -- a student
     * with three agents told each of them separately that they read on a phone.
     */
    expect(await systemPrompt('# Lucas')).not.toMatch(/what you know about this student/i);
  });

  it('does not still carry the instruction the document replaced', async () => {
    // "Be direct and useful; skip preamble" moved into responding.md. Left in
    // both places it would drift, and the two copies would disagree.
    expect(await systemPrompt()).not.toContain('skip preamble');
  });

  /*
   * The reading rules used to ride on every turn of every student with a
   * vault. Now the prompt says what skills exist and when to load one, and
   * the rules arrive only on a turn that asks -- which is what keeps "what is
   * 2+2" from paying for a page about wikilinks.
   */
  it('names the skills and the tool that loads them', () => {
    const prompt = buildSystemPrompt('help', [], undefined, true);
    expect(prompt).toContain('Skills:');
    expect(prompt).toContain('skill_load');
    expect(prompt).toContain('- browser: ');
  });

  it('names the vault skills only when there is a vault', () => {
    expect(buildSystemPrompt('help', [], undefined, true)).toContain('- vault-reading: ');
    expect(buildSystemPrompt('help', [], undefined, true)).toContain('- vault-writing: ');
    expect(buildSystemPrompt('help', [], undefined, false)).not.toContain('vault-reading');
    expect(buildSystemPrompt('help', [], undefined, false)).not.toContain('vault-writing');
  });

  it('no longer carries the reading rules whole', () => {
    expect(buildSystemPrompt('help', [], undefined, true)).not.toContain(VAULT_READING.body);
  });

  it('keeps the skills block in the universal tier, above anything per agent', () => {
    const prompt = buildSystemPrompt('keep me on top of chemistry', [], '# Lucas', true);
    expect(prompt.indexOf('Skills:')).toBeLessThan(prompt.indexOf('Your purpose'));
    expect(prompt.indexOf('Skills:')).toBeLessThan(prompt.indexOf('# Lucas'));
  });

  it('carries the working document above the per-agent tier', () => {
    const prompt = buildSystemPrompt('keep me on top of chemistry', [], '# Lucas', true);
    expect(prompt).toContain(WORKING.body);
    expect(prompt.indexOf(WORKING.body)).toBeLessThan(prompt.indexOf('Your purpose'));
    expect(prompt.indexOf(WORKING.body)).toBeLessThan(prompt.indexOf('# Lucas'));
  });

  it('tells the model to load the browser skill before touching a site', () => {
    expect(buildSystemPrompt('help', [])).toMatch(/load the browser skill/i);
  });
});

describe('what the model is asked for', () => {
  it('runs the turn at xhigh with a hard output cap', async () => {
    const seen: unknown[] = [];
    const deps = {
      llm: {
        chat: async (request: unknown) => {
          seen.push(request);
          return { content: 'ok', toolCalls: [], usage, finishReason: 'stop' as const };
        },
      },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools: new ToolRegistry(),
      transcript: new InMemoryTranscriptStore(),
    } as unknown as AgentRunDeps;
    await runAgentTurn(deps, { userId: 'u1', agentId: 'a1', purpose: '', message: 'hi' } as never);
    expect(seen[0]).toMatchObject({ effort: 'xhigh', maxOutputTokens: 32_000 });
  });

  it('gives the model its own reasoning back on the next step of a turn', async () => {
    const payload = { format: 'openai_responses' as const, items: [{ type: 'reasoning' }] };
    const requests: { messages: { role: string; payload?: unknown }[] }[] = [];
    let turn = 0;
    const tools = new ToolRegistry();
    tools.register({
      id: 'probe',
      description: 'x',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    } as never);
    const deps = {
      llm: {
        chat: async (request: { messages: { role: string; payload?: unknown }[] }) => {
          requests.push(request);
          turn += 1;
          return turn === 1
            ? {
                content: '',
                toolCalls: [{ id: 'c1', name: 'probe', arguments: '{}' }],
                payload,
                usage,
                finishReason: 'tool_calls' as const,
              }
            : { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
        },
      },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools,
      transcript: new InMemoryTranscriptStore(),
    } as unknown as AgentRunDeps;
    await runAgentTurn(deps, { userId: 'u1', agentId: 'a1', purpose: '', message: 'go' } as never);
    const assistant = requests[1]?.messages.find((m) => m.role === 'assistant');
    expect(assistant?.payload).toEqual(payload);
  });
});

/**
 * The turn replays the conversation rather than a summary of it.
 *
 * What the model is sent is now the stored transcript: the student's words,
 * its own replies, the tools it called and what they returned. The failure
 * this guards against is the one the memory block had -- an agent that is told
 * about its last turn in the third person, cannot see the tool result it just
 * read, and asks the student to repeat themselves.
 */
describe('the conversation the model sees', () => {
  type Request = { messages: { role: string; content: string; payload?: unknown }[] };

  const input = (message: string, extra: Record<string, unknown> = {}) =>
    ({ userId: 'u1', agentId: 'a1', purpose: 'test', message, ...extra }) as never;

  const answer = (content: string) => ({
    content,
    toolCalls: [],
    usage,
    finishReason: 'stop' as const,
  });

  const callTool = (name: string, payload?: unknown) => ({
    content: '',
    toolCalls: [{ id: 'c1', name, arguments: '{}' }],
    ...(payload ? { payload } : {}),
    usage,
    finishReason: 'tool_calls' as const,
  });

  /** One tool, doing whatever the test needs it to do. */
  function registry(id: string, execute: () => Promise<unknown>): ToolRegistry {
    const tools = new ToolRegistry();
    tools.register({
      id,
      description: 'a tool',
      inputSchema: z.object({}),
      execute,
    } as never);
    return tools;
  }

  it('replays the last turn, tools and all', async () => {
    const payload = { format: 'openai_responses' as const, items: [{ type: 'reasoning' }] };
    const requests: Request[] = [];
    let call = 0;
    const deps = depsWith(
      async (request) => {
        requests.push(request as Request);
        call += 1;
        if (call === 1) return callTool('probe', payload);
        return answer(call === 2 ? 'A' : 'B');
      },
      registry('probe', async () => 'ok'),
    );

    await runAgentTurn(deps, input('first question'));
    await runAgentTurn(deps, input('second question'));

    const replay = requests[2];
    expect(replay?.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    // The stored message, as the student typed it: the clock that rode with it
    // has been stale for a turn and must not be replayed as if it were true.
    expect(replay?.messages[1]?.content).toContain('first question');
    expect(replay?.messages[1]?.content).not.toContain('<turn_context>');
    // Its own reasoning back, so the second turn continues the first rather
    // than starting over from the text.
    expect(replay?.messages[2]?.payload).toEqual(payload);
    expect(replay?.messages[4]?.content).toBe('A');
    expect(replay?.messages[5]?.content).toContain('<turn_context>');
    expect(replay?.messages[5]?.content).toContain('second question');

    // The stored result names the tool that produced it: the id alone is a
    // provider's pairing key, not something a transcript view can read.
    const result = (await deps.transcript.load('a1')).find(
      (item) => item.payload.kind === 'tool_result',
    );
    expect(result?.payload).toMatchObject({ toolName: 'probe', toolCallId: 'c1' });
  });

  it('stores the reply with the reasoning that produced it', async () => {
    const payload = {
      format: 'openai_responses' as const,
      items: [{ type: 'reasoning' }, { type: 'message' }],
    };
    const requests: Request[] = [];
    const deps = depsWith(async (request) => {
      requests.push(request as Request);
      return { content: 'A', toolCalls: [], payload, usage, finishReason: 'stop' as const };
    });

    await runAgentTurn(deps, input('first question'));

    const [, stored] = await deps.transcript.load('a1');
    expect(stored?.payload).toEqual({
      kind: 'assistant',
      content: 'A',
      // What the request cost, which is what the compaction estimate anchors on.
      usage: { inputTokens: 1, cachedInputTokens: 0 },
    });
    expect(stored?.providerPayload).toEqual(payload);

    await runAgentTurn(deps, input('second question'));

    expect(requests[1]?.messages.find((m) => m.role === 'assistant')?.payload).toEqual(payload);
  });

  it('keeps the reasoning behind a reply the student never saw out of the transcript', async () => {
    /*
     * The model said nothing and the fallback answered for it. Storing that
     * response's payload would replay reasoning with no message under it --
     * the provider can refuse the whole request over that, and an append-only
     * transcript would carry it on every turn from here on.
     */
    const deps = depsWith(async () => ({
      content: '',
      toolCalls: [],
      payload: { format: 'openai_responses' as const, items: [{ type: 'reasoning' }] },
      usage,
      finishReason: 'stop' as const,
    }));

    const { reply } = await runAgentTurn(deps, input('go'));

    expect(reply.trim()).not.toBe('');
    const stored = (await deps.transcript.load('a1')).at(-1);
    expect(stored?.payload).toMatchObject({ kind: 'assistant', content: reply });
    expect(stored?.providerPayload).toBeUndefined();
  });

  it('no longer pastes memory into the turn', async () => {
    const requests: Request[] = [];
    const deps = {
      llm: {
        chat: async (request: unknown) => {
          requests.push(request as Request);
          return answer('ok');
        },
      },
      memory: {
        recall: async () => ({
          summaries: [],
          recent: [{ kind: 'conversation', content: 'Student: NEVER SEEN\nAgent: nor this' }],
        }),
        record: async () => ({}),
      },
      skills: { list: async () => [] },
      tools: new ToolRegistry(),
      transcript: new InMemoryTranscriptStore(),
    } as unknown as AgentRunDeps;

    await runAgentTurn(deps, input('go'));

    expect(JSON.stringify(requests)).not.toContain('NEVER SEEN');
  });

  it('runs independent tool calls at once', async () => {
    const events: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tools = new ToolRegistry();
    for (const id of ['one', 'two']) {
      tools.register({
        id,
        description: 'a tool',
        inputSchema: z.object({}),
        execute: async () => {
          events.push(`start ${id}`);
          // Only once both are in flight -- run one after the other and this
          // never resolves, so the test times out rather than passing slowly.
          if (events.length === 2) release();
          await gate;
          events.push(`done ${id}`);
          return 'ok';
        },
      } as never);
    }

    let call = 0;
    const deps = depsWith(async () => {
      call += 1;
      return call === 1
        ? {
            content: '',
            toolCalls: [
              { id: 'c1', name: 'one', arguments: '{}' },
              { id: 'c2', name: 'two', arguments: '{}' },
            ],
            usage,
            finishReason: 'tool_calls' as const,
          }
        : answer('done');
    }, tools);

    await runAgentTurn(deps, input('go'));

    expect(events.slice(0, 2)).toEqual(['start one', 'start two']);
    expect(events).toHaveLength(4);
  });

  it("keeps a tool's error inside the turn", async () => {
    const requests: Request[] = [];
    let call = 0;
    const deps = depsWith(
      async (request) => {
        requests.push(request as Request);
        call += 1;
        return call === 1 ? callTool('boom') : answer('The site would not load.');
      },
      registry('boom', async () => {
        throw new Error('no network');
      }),
    );

    const { reply } = await runAgentTurn(deps, input('go'));

    expect(reply).toBe('The site would not load.');
    expect(requests[1]?.messages.find((m) => m.role === 'tool')?.content).toContain('failed: ');
  });

  it('cuts an oversized tool result before the model sees it', async () => {
    const requests: Request[] = [];
    let call = 0;
    const deps = depsWith(
      async (request) => {
        requests.push(request as Request);
        call += 1;
        return call === 1 ? callTool('firehose') : answer('done');
      },
      registry('firehose', async () => 'x'.repeat(50_000)),
    );

    await runAgentTurn(deps, input('go'));

    expect(requests[1]?.messages.find((m) => m.role === 'tool')?.content).toContain(
      'characters truncated',
    );
    // Marked as cut where it is stored too, so a later reader knows the result
    // it is looking at is not the whole of what the tool said.
    const stored = (await deps.transcript.load('a1')).find(
      (item) => item.payload.kind === 'tool_result',
    );
    expect(stored?.payload).toMatchObject({ toolName: 'firehose', truncated: true });
  });

  it("writes nothing after the student's message when the loop throws", async () => {
    // Half a turn is worse than none: a stored assistant item with no result
    // beside it would be replayed forever as a reply that never happened.
    const deps = depsWith(async () => {
      throw new Error('the model is down');
    });

    await expect(runAgentTurn(deps, input('go'))).rejects.toThrow('the model is down');

    const items = await deps.transcript.load('a1');
    expect(items).toHaveLength(1);
    expect(items[0]?.payload.kind).toBe('user');
  });

  it('clears an earlier tool result behind a watermark once the budget is tight', async () => {
    // A usage big enough that even one turn's worth of it exceeds the tiny
    // threshold below -- the point of this test is the wiring, not the size.
    const bigUsage = { inputTokens: 100, outputTokens: 1, cachedInputTokens: 0 };
    const requests: Request[] = [];
    let call = 0;
    const deps = depsWith(
      async (request) => {
        requests.push(request as Request);
        call += 1;
        return call === 1
          ? {
              content: '',
              toolCalls: [{ id: 'c1', name: 'probe', arguments: '{}' }],
              usage: bigUsage,
              finishReason: 'tool_calls' as const,
            }
          : {
              content: call === 2 ? 'A' : 'B',
              toolCalls: [],
              usage: bigUsage,
              finishReason: 'stop' as const,
            };
      },
      registry('probe', async () => 'ok'),
    );
    const contextBudget = { clearToolResultsAboveTokens: 1, keepRecentToolResults: 0 };

    await runAgentTurn(deps, input('first question', { contextBudget }));
    await runAgentTurn(deps, input('second question', { contextBudget }));

    const replay = requests[2];
    expect(replay?.messages.find((m) => m.role === 'tool')?.content).toContain('cleared');
  });

  it('hands the older part of a long chat to the next turn as a summary', async () => {
    // A usage big enough that a single turn's worth of it exceeds the tiny
    // threshold below -- the point of this test is the wiring, not the size.
    const bigUsage = { inputTokens: 100, outputTokens: 1, cachedInputTokens: 0 };
    const requests: Request[] = [];
    const deps = depsWith(async (request) => {
      const chatRequest = request as Request;
      requests.push(chatRequest);
      const summarising = chatRequest.messages[0]?.content === COMPACTION.body;
      return {
        content: summarising ? 'SUMMARY' : 'ok',
        toolCalls: [],
        usage: bigUsage,
        finishReason: 'stop' as const,
      };
    });
    const contextBudget = { compactAboveTokens: 1, keepLastUserTurns: 1 };

    await runAgentTurn(deps, input('first question', { contextBudget }));
    await runAgentTurn(deps, input('second question', { contextBudget }));
    await runAgentTurn(deps, input('third question', { contextBudget }));

    // Four calls, not five: the second turn has only one user item in its
    // history, which is the whole of the kept tail, so nothing is summarised
    // until the third turn loads two.
    expect(requests).toHaveLength(4);
    const replay = requests.at(-1);
    expect(replay?.messages[1]?.content.startsWith(COMPACTION_HANDOFF)).toBe(true);
    expect(replay?.messages[1]?.content).toContain('SUMMARY');
  });

  it('stores the files with the message that brought them, and only there', async () => {
    const requests: Request[] = [];
    const deps = depsWith(async (request) => {
      requests.push(request as Request);
      return answer('ok');
    });

    await runAgentTurn(
      deps,
      input('what is this', { attachments: [{ name: 'board', body: 'A brass connector.' }] }),
    );
    await runAgentTurn(deps, input('what size is the thread'));

    const users = requests[1]?.messages.filter((m) => m.role === 'user') ?? [];
    expect(users[0]?.content).toContain('A brass connector.');
    expect(users.at(-1)?.content).not.toContain('A brass connector.');
  });
});

/**
 * The plan, recited where the model is actually looking.
 *
 * A plan stated once at the top of a conversation is the plan the model stops
 * seeing: the middle of a long context is where attention is weakest. So it is
 * rewritten at the end of every turn's context -- under the clock, directly
 * above what the student just typed -- and says so when it has gone stale.
 */
describe('the plan in the turn context', () => {
  type Seen = { role: string; content: string };

  const steps = [
    { step: 'Read the brief', status: 'completed' as const },
    { step: 'Draft the answer', status: 'in_progress' as const },
  ];

  /** Records what the turn sends, with a plan store and a transcript of its own. */
  function planDeps(plan: AgentPlan | null, transcript = new InMemoryTranscriptStore()) {
    const seen: Seen[] = [];
    const deps = {
      llm: {
        async chat(request: unknown) {
          seen.push(...(request as { messages: Seen[] }).messages);
          return {
            content: 'done',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: 'stop' as const,
          };
        },
      },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools: new ToolRegistry(),
      transcript,
      plans: { read: async () => plan, save: async () => {} },
    } as unknown as AgentRunDeps;
    return { deps, seen };
  }

  /** What rode in front of the student's message on the last request sent. */
  function turnContextOf(seen: Seen[]): string {
    const user = seen.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    return user.slice(user.indexOf('<turn_context>'), user.indexOf('</turn_context>'));
  }

  const ask = {
    userId: 'u1',
    agentId: 'a1',
    purpose: 'keep me on top of chemistry',
    message: 'go',
    timezone: 'Europe/London',
  } as never;

  it('recites the plan as the last section, under the clock', async () => {
    // seq 1 is this turn's own user item: the plan was written a turn ago, so
    // nothing is stale.
    const { deps, seen } = planDeps({ steps, updatedAtSeq: 1 });

    await runAgentTurn(deps, ask);

    const context = turnContextOf(seen);
    expect(context).toContain('[in progress] Draft the answer');
    // Last, because that is where attention is strongest -- not merely present.
    expect(context.indexOf('Your plan for this conversation')).toBeGreaterThan(
      context.indexOf('Right now it is'),
    );
    expect(context.trimEnd().endsWith('2. [in progress] Draft the answer')).toBe(true);
    expect(context).not.toMatch(/not been updated/);
  });

  it('nudges the model once the plan has gone a few turns without a write', async () => {
    const transcript = new InMemoryTranscriptStore();
    await transcript.append(
      ['first', 'second', 'third'].map((content) => ({
        agentId: 'a1',
        turnId: 'earlier',
        payload: { kind: 'user' as const, content },
      })),
    );
    // Written on the first of those turns: two user turns have gone by since,
    // and this one makes three.
    const { deps, seen } = planDeps({ steps, updatedAtSeq: 1 }, transcript);

    await runAgentTurn(deps, ask);

    expect(turnContextOf(seen)).toMatch(/not been updated for a few turns/);
  });

  it('says nothing about a plan when there is none', async () => {
    // A heading with no steps under it tells the model there is supposed to be
    // a plan here and that it is empty.
    const { deps, seen } = planDeps(null);

    await runAgentTurn(deps, ask);

    const context = turnContextOf(seen);
    expect(context).toContain('Right now it is');
    expect(context).not.toContain('Your plan for this conversation');
  });

  it('hands the plan store and this turn to the tools', async () => {
    // What plan_update writes with: without the seq, every plan it saves looks
    // like it was written on turn zero and is stale the moment it lands.
    const contexts: ToolContext[] = [];
    const tools = new ToolRegistry();
    tools.register({
      id: 'probe',
      description: 'records the context it receives',
      inputSchema: z.object({}),
      execute: async (_input: Record<string, never>, ctx: ToolContext) => {
        contexts.push(ctx);
        return 'ok';
      },
    } as never);

    let asked = false;
    const plans = { read: async () => null, save: async () => {} };
    const transcript = new InMemoryTranscriptStore();
    const deps = {
      llm: {
        async chat() {
          const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
          if (asked)
            return { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
          asked = true;
          return {
            content: '',
            toolCalls: [{ id: 'c1', name: 'probe', arguments: '{}' }],
            usage,
            finishReason: 'tool_calls' as const,
          };
        },
      },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools,
      transcript,
      plans,
    } as unknown as AgentRunDeps;

    await runAgentTurn(deps, ask);

    const stored = (await transcript.load('a1')).find((item) => item.payload.kind === 'user');
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.plans).toBe(plans);
    expect(contexts[0]?.turnSeq).toBe(stored?.seq);
  });
});
