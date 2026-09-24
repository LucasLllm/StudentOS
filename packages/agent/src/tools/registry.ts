import { z } from 'zod';
import type { ToolDefinition } from '@contexto/llm';
import type { Tool, ToolContext } from './types.js';

/**
 * The set of tools available to an agent run.
 *
 * Deliberately per-run rather than global: which tools an agent gets depends on
 * which Google scopes that student granted, so the set is assembled per
 * request. Registering a Gmail tool for a student who never connected Gmail
 * just wastes context and invites the model to call something that cannot
 * work.
 */
/**
 * What every provider accepts as a function name.
 *
 * OpenAI enforces ^[a-zA-Z0-9_-]+$ and rejects the ENTIRE request if one name
 * fails -- so a single bad id breaks every turn for that student, not just the
 * tool it belongs to. Anthropic's rules are similar. Checking at registration
 * turns that runtime 400 into a loud failure the moment a tool is added.
 */
const PROVIDER_SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export class ToolRegistry {
  readonly #tools = new Map<string, Tool<never, unknown>>();

  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): this {
    if (!PROVIDER_SAFE_ID.test(tool.id)) {
      throw new Error(
        `Tool id "${tool.id}" is not usable as a provider function name. ` +
          'Allowed: letters, digits, underscore, hyphen; 1-64 characters. ' +
          'Dots and spaces are rejected by OpenAI and fail the whole request.',
      );
    }

    if (this.#tools.has(tool.id)) {
      throw new Error(`Tool "${tool.id}" is already registered`);
    }
    this.#tools.set(tool.id, tool as unknown as Tool<never, unknown>);
    return this;
  }

  /**
   * Take a tool back out. For a chat that must not have one the student's
   * grants would otherwise give it -- a project chat writing to the vault
   * every other chat reads.
   */
  unregister(id: string): this {
    this.#tools.delete(id);
    return this;
  }

  get(id: string): Tool<never, unknown> | undefined {
    return this.#tools.get(id);
  }

  ids(): string[] {
    return [...this.#tools.keys()];
  }

  /** Provider-neutral definitions to send with a chat request. */
  toDefinitions(): ToolDefinition[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.id,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    }));
  }

  /**
   * Parse arguments and run the tool.
   *
   * `rawArguments` is the JSON string the model produced. It is parsed and
   * schema-validated here, and the tool body is run inside a try/catch, so a
   * malformed tool call or a thrown error both become an error message the
   * model can recover from rather than a thrown exception mid-run.
   */
  async execute(id: string, rawArguments: string, ctx: ToolContext): Promise<unknown> {
    const tool = this.#tools.get(id);
    if (!tool) {
      return { error: `Unknown tool "${id}"` };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawArguments);
    } catch {
      return { error: 'Arguments were not valid JSON' };
    }

    const result = tool.inputSchema.safeParse(parsedJson);
    if (!result.success) {
      return { error: `Invalid arguments: ${result.error.message}` };
    }

    try {
      return await tool.execute(result.data as never, ctx);
    } catch (error) {
      return { error: `${id} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
