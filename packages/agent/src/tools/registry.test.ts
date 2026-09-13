import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import { buildToolRegistry } from './builtin.js';
import { SCOPE_GROUPS } from './google/scopes.js';

/** Everything a fully-approved student would hold. */
const ALL_GRANTED = Object.values(SCOPE_GROUPS)
  .flatMap((group) => [...group.required, ...group.optional, ...(group.elective ?? [])])
  .join(',');
import type { Tool } from './types.js';

const tool = (id: string): Tool<Record<string, never>, string> => ({
  id,
  description: 'test tool',
  inputSchema: z.object({}),
  execute: async () => 'ok',
});

/**
 * Providers constrain tool names and reject the whole request if one is
 * invalid -- OpenAI requires ^[a-zA-Z0-9_-]+$ and 400s the entire call, so a
 * single bad name takes down every turn for that student, not just that tool.
 *
 * Enforcing it at registration turns a runtime 400 into a startup failure.
 */
const PROVIDER_SAFE = /^[a-zA-Z0-9_-]{1,64}$/;

describe('tool name constraints', () => {
  it('every built-in tool has a provider-safe id', () => {
    // The regression: ids used dots (google_classroom.list_courses), which every
    // provider rejects. It stayed invisible because the registry was empty
    // until a student actually connected Google.
    const registry = buildToolRegistry(ALL_GRANTED);
    const ids = registry.ids();

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id, `tool id "${id}" is not provider-safe`).toMatch(PROVIDER_SAFE);
    }
  });

  it('rejects a tool whose id a provider would refuse', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(tool('has.a.dot'))).toThrow(/[a-zA-Z0-9_-]/);
    expect(() => registry.register(tool('has space'))).toThrow();
    expect(() => registry.register(tool('has/slash'))).toThrow();
    expect(() => registry.register(tool(''))).toThrow();
    expect(() => registry.register(tool('a'.repeat(65)))).toThrow();
  });

  it('accepts ordinary ids', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(tool('google_classroom_list_courses'))).not.toThrow();
    expect(() => registry.register(tool('some-tool-2'))).not.toThrow();
  });

  it('rejects a duplicate registration', () => {
    const registry = new ToolRegistry();
    registry.register(tool('dupe'));
    expect(() => registry.register(tool('dupe'))).toThrow(/already registered/);
  });
});

describe('execute', () => {
  const registry = new ToolRegistry().register({
    id: 'echo',
    description: 'echoes',
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => ({ echoed: input.text }),
  });

  const ctx = { userId: 'u1', agentId: 'a1' };

  it('parses and runs', async () => {
    expect(await registry.execute('echo', '{"text":"hi"}', ctx)).toEqual({ echoed: 'hi' });
  });

  it('returns an error object rather than throwing on bad JSON', async () => {
    // A malformed tool call must become something the model can recover from,
    // not an exception that kills the turn.
    expect(await registry.execute('echo', 'not json', ctx)).toEqual({
      error: 'Arguments were not valid JSON',
    });
  });

  it('returns an error object when arguments fail the schema', async () => {
    const result = (await registry.execute('echo', '{"text":123}', ctx)) as { error: string };
    expect(result.error).toMatch(/Invalid arguments/);
  });

  it('returns an error object for an unknown tool', async () => {
    expect(await registry.execute('nope', '{}', ctx)).toEqual({ error: 'Unknown tool "nope"' });
  });

  it('turns a thrown error into a result the model can act on', async () => {
    const tools = new ToolRegistry();
    tools.register({
      id: 'boom',
      description: 'throws',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('upstream 503');
      },
    } as never);
    await expect(tools.execute('boom', '{}', ctx)).resolves.toEqual({
      error: 'boom failed: upstream 503',
    });
  });
});

describe('toDefinitions', () => {
  it('emits provider-safe names and a JSON Schema', () => {
    const definitions = buildToolRegistry(ALL_GRANTED).toDefinitions();
    expect(definitions.length).toBeGreaterThan(0);

    for (const def of definitions) {
      expect(def.name).toMatch(PROVIDER_SAFE);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.parameters).toHaveProperty('type', 'object');
    }
  });
});

describe('scope declarations', () => {
  /**
   * The guard that lets buildToolRegistry register scope-free tools safely.
   *
   * Registration now treats "no requiredScopes" as "needs no Google grant".
   * That is correct for web_read_link, and silently wrong for a google_* tool
   * that simply forgot to declare its scopes -- it would register for every
   * student and fail at call time. Catch that here rather than by banning
   * scope-free tools, which only hid the mistake in the other direction.
   */
  it('every google tool declares the scopes it needs', () => {
    const registry = buildToolRegistry(ALL_GRANTED);

    const undeclared = registry
      .ids()
      .filter((id) => id.startsWith('google_'))
      .filter((id) => (registry.get(id)?.requiredScopes ?? []).length === 0);

    expect(undeclared).toEqual([]);
  });

  /** Tools needing no Google data must work for a student with no grant. */
  it('registers scope-free tools when nothing is connected', () => {
    const ids = buildToolRegistry(null).ids();

    expect(ids).toContain('web_read_link');
    expect(ids).toContain('skill_load');
    expect(ids.filter((id) => id.startsWith('google_'))).toEqual([]);
  });
});

describe('switched-off integrations', () => {
  /**
   * A student turning Gmail off must remove the tools entirely, not leave
   * them registered to refuse at call time. Registering them would burn a
   * turn discovering the refusal and read as the product being broken rather
   * than as their own setting.
   */
  it('removes the tools for an integration that is switched off', () => {
    const on = buildToolRegistry(ALL_GRANTED).ids();
    const off = buildToolRegistry(ALL_GRANTED, ['gmail']).ids();

    expect(on.some((id) => id.startsWith('gmail_'))).toBe(true);
    expect(off.some((id) => id.startsWith('gmail_'))).toBe(false);
  });

  it('leaves every other integration alone', () => {
    const off = buildToolRegistry(ALL_GRANTED, ['gmail']).ids();

    expect(off.some((id) => id.startsWith('google_classroom_'))).toBe(true);
    expect(off.some((id) => id.startsWith('google_drive_'))).toBe(true);
  });

  it('can switch several off at once', () => {
    const ids = buildToolRegistry(ALL_GRANTED, ['gmail', 'drive']).ids();

    expect(ids.some((id) => id.startsWith('gmail_'))).toBe(false);
    expect(ids.some((id) => id.startsWith('google_drive_'))).toBe(false);
    expect(ids.some((id) => id.startsWith('google_classroom_'))).toBe(true);
  });

  /**
   * The write half comes with the integration: sending follows Gmail, turning
   * work in follows Classroom. A 'gmail:write' key left over from when those
   * had switches of their own is ignored rather than honoured -- a student
   * who turned sending off then has it back, which is what the change means.
   */
  it('keeps the write tools when only a stale write key is present', () => {
    const ids = buildToolRegistry(ALL_GRANTED, ['gmail:write', 'classroom:write'] as never).ids();

    expect(ids).toContain('gmail_send_message');
    expect(ids).toContain('google_classroom_turn_in');
  });

  it('removes the write tools with the whole integration', () => {
    const ids = buildToolRegistry(ALL_GRANTED, ['gmail']).ids();
    expect(ids.some((id) => id.startsWith('gmail_'))).toBe(false);
  });

  it('ignores an unknown key rather than throwing', () => {
    const ids = buildToolRegistry(ALL_GRANTED, ['nonsense' as never]).ids();
    expect(ids.length).toBeGreaterThan(0);
  });

  /** Tools needing no Google grant are unaffected by any of this. */
  it('keeps scope-free tools regardless', () => {
    const ids = buildToolRegistry(ALL_GRANTED, ['gmail', 'drive', 'classroom']).ids();
    expect(ids).toContain('web_read_link');
  });
});
