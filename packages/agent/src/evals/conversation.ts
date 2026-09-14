import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { OpenAiProvider, PLATFORM_MODEL } from '@contexto/llm';
import type { ChatRequest, ChatResponse, ProviderContext } from '@contexto/llm';
import { COMPACTION } from '../prompts/documents.js';
import { runAgentTurn } from '../run.js';
import type { AgentRunDeps } from '../run.js';
import { queryTerms, rankByTermMatches } from '../memory/search.js';
import type { EpisodicMemory, MemoryStore, RecallOptions } from '../memory/types.js';
import { InMemoryPlanStore } from '../plan/store.js';
import type { PlanStep } from '../plan/types.js';
import { searchMemory } from '../tools/memory.js';
import { updatePlan } from '../tools/plan.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/types.js';
import type { ContextBudget } from '../transcript/budget.js';
import { InMemoryTranscriptStore } from '../transcript/in-memory.js';
import { CONVERSATION_CASES } from './conversation-cases.js';
import { gradeTurn } from './conversation-grader.js';
import type { ConversationCase, ConversationCategory } from './conversation-grader.js';

/**
 * Does the harness still know what the student said twenty turns ago?
 *
 *   pnpm --filter @contexto/agent eval:conversation
 *
 * Every other eval seeds a history and asks one question, which can never
 * show what clearing and compaction cost: a seeded transcript is never
 * compacted. This one says every turn out loud through the real turn loop, so
 * the budget actually fires mid-conversation and the fact being asked for at
 * the end has genuinely been summarised or cleared away first.
 *
 * Two arms per case. `default` runs the production budget, which a twenty-turn
 * chat never reaches -- it is the control, the score the compacted arm has to
 * match. `compacted` forces the thresholds down far enough that a short
 * conversation clears tool results and compacts turns several times over. A
 * gap between the two arms is the harness losing something, and which case
 * fails says what.
 *
 * It costs real money to run: roughly a hundred model calls.
 */

/** Mirrors apps/api/src/env.ts -- walk up for .env rather than trusting cwd. */
function loadDotEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/**
 * Thresholds low enough that twenty ordinary turns trip them repeatedly.
 *
 * Production's are 40k/80k tokens, which no scripted conversation will ever
 * reach -- forcing them down is the only way to exercise clearing and
 * compaction without paying for tens of thousands of tokens of real chat
 * first. Keeping one recent tool result and two recent user turns is the
 * harshest setting the code allows, which is the point: if the answers
 * survive this, they survive anything production does.
 */
const FORCED_BUDGET: Partial<ContextBudget> = {
  compactAboveTokens: 2_000,
  keepLastUserTurns: 2,
  clearToolResultsAboveTokens: 1_000,
  keepRecentToolResults: 1,
};

const ARMS = ['default', 'compacted'] as const;
type Arm = (typeof ARMS)[number];

/**
 * The Postgres store's behaviour, in memory, filling up as the chat runs.
 *
 * The memory eval seeds this from a fixed history; here the turns write it
 * themselves, because memory_search is the agent's last route back to a turn
 * compaction has summarised away. Seeding it would hand the agent facts the
 * conversation had not yet produced.
 */
function growingStore(): MemoryStore {
  const entries: EpisodicMemory[] = [];

  return {
    record: async (input) => {
      const now = new Date();
      const entry: EpisodicMemory = {
        id: `m${entries.length}`,
        agentId: input.agentId,
        kind: input.kind,
        content: input.content,
        source: input.source,
        occurredAt: input.occurredAt ?? now,
        createdAt: now,
      };
      entries.push(entry);
      return entry;
    },
    recall: async (_agentId: string, options: RecallOptions = {}) => ({
      summaries: [],
      recent: entries.slice(-(options.limit ?? 8)),
    }),
    // The same ranking the Postgres store uses, so this measures what ships.
    search: async (_agentId: string, query: string, limit = 8) =>
      rankByTermMatches(entries, queryTerms(query)).slice(0, limit),
    unsummarized: async () => [],
    saveSummary: async () => {
      throw new Error('not used by this eval');
    },
  };
}

const probeSchema = z.object({
  query: z.string().describe('What to look for, e.g. "due this week"'),
});

/**
 * A school portal that answers once and is never reachable again.
 *
 * The tool-recall case turns on the agent having kept what the tool said
 * rather than being able to ask again: clearing throws away old tool results
 * first and hardest, and an agent that simply re-runs the tool would pass
 * without having remembered anything. Failing on every later call is what
 * makes the first answer the only copy.
 */
function classroomProbe(): Tool<z.infer<typeof probeSchema>, { due: string } | { error: string }> {
  let answered = false;

  return {
    id: 'classroom_probe',
    description:
      'Look up what this student has due in their school classroom. Call it when they ask ' +
      'what is coming up, what is set, or what is due.',
    inputSchema: probeSchema,
    execute: async () => {
      if (answered) return { error: 'unavailable' };
      answered = true;
      return { due: 'Physics lab report, due Thursday 22 May' };
    },
  };
}

/**
 * Did the provider hand back reasoning to replay?
 *
 * OpenAI returns reasoning as encrypted items on the response, and the turn
 * loop only keeps its train of thought across tool calls if those items come
 * back and go out again. Nothing else in the response says whether that is
 * happening, and it failing is silent -- the agent just gets worse at
 * multi-step work.
 */
function carriesReasoning(response: ChatResponse): boolean {
  return (response.payload?.items ?? []).some(
    (item) =>
      typeof item === 'object' && item !== null && ('phase' in item || 'encrypted_content' in item),
  );
}

/** The plan a `plan_update` call actually saved, as the tool reports it back. */
function savedPlan(result: unknown): PlanStep[] | undefined {
  const write = result as { saved?: true; plan?: PlanStep[] } | null;
  return write?.saved ? write.plan : undefined;
}

/**
 * A step that jumped straight from pending to completed.
 *
 * working.md tells the model never to do this, and the reason is the student:
 * a plan that only ever shows finished work gives them nothing to watch
 * happening. Comparing consecutive saved plans is the only way to see it --
 * the final plan looks identical either way.
 */
// Matched by their text: a PlanStep has no id, and the model may reorder or
// reword the list between calls.
function skippedInProgress(plans: PlanStep[][]): string | undefined {
  for (let i = 1; i < plans.length; i++) {
    const before = new Map((plans[i - 1] ?? []).map((step) => [step.step, step.status]));
    for (const step of plans[i] ?? []) {
      if (step.status === 'completed' && before.get(step.step) === 'pending') {
        return `"${step.step}" went pending -> completed`;
      }
    }
  }
  return undefined;
}

/** The plan's shape at the end: one step running, or the job finished. */
function badFinalPlan(steps: PlanStep[]): string | undefined {
  if (steps.every((step) => step.status === 'completed')) return undefined;
  const running = steps.filter((step) => step.status === 'in_progress').length;
  return running === 1 ? undefined : `final plan has ${running} steps in progress`;
}

interface TurnStat {
  inputTokens: number;
  cachedInputTokens: number;
  ranOutOfRoom: boolean;
  replayedReasoning: boolean;
}

interface Outcome {
  testCase: ConversationCase;
  arm: Arm;
  passed: boolean;
  why: string;
  /** Summariser calls this arm made -- one per compaction. */
  compactions: number;
  /** Mean cached share of the input, over the turns a cache should be warm by. */
  cacheRatio: number;
  lengthFinishes: number;
  reasoningTurns: number;
}

async function runArm(apiKey: string, testCase: ConversationCase, arm: Arm): Promise<Outcome> {
  const provider = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });
  const transcript = new InMemoryTranscriptStore();
  const plans = new InMemoryPlanStore();

  const tools = new ToolRegistry();
  tools.register(searchMemory as never);
  tools.register(updatePlan as never);
  tools.register(classroomProbe() as never);

  /*
   * Every plan the model saved, in order.
   *
   * Only the ones that landed: a plan validatePlan rejected was never the
   * agent's plan, and counting it would report a regression that never
   * reached storage.
   */
  const planWrites: PlanStep[][] = [];
  const execute = tools.execute.bind(tools);
  tools.execute = async (id, rawArguments, ctx) => {
    const result = await execute(id, rawArguments, ctx);
    if (id === updatePlan.id) {
      const saved = savedPlan(result);
      if (saved) planWrites.push(saved);
    }
    return result;
  };

  /*
   * Every model call the turn made, including the summariser's: a compaction
   * is part of what the turn cost the student and belongs in its numbers.
   *
   * The summariser's calls are also counted, because they are the only honest
   * count of how often this arm compacted. The transcript cannot say: load()
   * returns the latest compaction item and drops the ones it superseded, so
   * five compactions and one look identical there. A compaction is exactly
   * one chat call opening with the summariser's own system prompt.
   */
  let compactions = 0;
  const calls: ChatResponse[] = [];
  const llm = {
    chat: async (request: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> => {
      const [first] = request.messages;
      if (first?.role === 'system' && first.content === COMPACTION.body) compactions += 1;
      const response = await provider.chat(request, ctx);
      calls.push(response);
      return response;
    },
  };

  const deps = {
    llm,
    memory: growingStore(),
    skills: { list: async () => [] },
    tools,
    transcript,
    plans,
  } as unknown as AgentRunDeps;

  const agentId = `${testCase.id}-${arm}`;
  const stats: TurnStat[] = [];
  const failures: string[] = [];

  for (const turn of testCase.turns) {
    const before = calls.length;

    const { reply } = await runAgentTurn(deps, {
      userId: 'eval',
      agentId,
      purpose: 'keep me on top of school',
      message: turn.say,
      timezone: 'Europe/London',
      ...(arm === 'compacted' ? { contextBudget: FORCED_BUDGET } : {}),
    });

    const made = calls.slice(before);
    stats.push({
      inputTokens: made.reduce((n, r) => n + r.usage.inputTokens, 0),
      cachedInputTokens: made.reduce((n, r) => n + r.usage.cachedInputTokens, 0),
      ranOutOfRoom: made.some((r) => r.finishReason === 'length'),
      replayedReasoning: made.some(carriesReasoning),
    });

    if (turn.expect ?? turn.expectAny ?? turn.reject) {
      const grade = gradeTurn(turn, reply);
      if (!grade.passed) failures.push(grade.why);
    }
  }

  if (testCase.category === 'goal') {
    const plan = await plans.read(agentId);
    if (!plan) {
      failures.push('never wrote a plan');
    } else {
      const shape = badFinalPlan(plan.steps);
      if (shape) failures.push(shape);
    }
    const skipped = skippedInProgress(planWrites);
    if (skipped) failures.push(skipped);
  }

  /*
   * Cache measured from turn five on.
   *
   * The first turns of a chat have almost nothing cacheable in front of them,
   * so scoring them would measure the start of the conversation rather than
   * the steady state. By turn five the system prompt and the early transcript
   * should be a stable prefix -- and if compaction is rewriting that prefix
   * every turn, this is where it shows.
   */
  const settled = stats.slice(4).filter((stat) => stat.inputTokens > 0);
  const cacheRatio =
    settled.length === 0
      ? 0
      : settled.reduce((n, stat) => n + stat.cachedInputTokens / stat.inputTokens, 0) /
        settled.length;

  return {
    testCase,
    arm,
    passed: failures.length === 0,
    why: failures.join('; ') || 'ok',
    compactions,
    cacheRatio,
    lengthFinishes: stats.filter((stat) => stat.ranOutOfRoom).length,
    reasoningTurns: stats.filter((stat) => stat.replayedReasoning).length,
  };
}

async function pooled<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (true) {
        const i = next++;
        const item = items[i];
        if (item === undefined) return;
        out[i] = await fn(item);
      }
    }),
  );
  return out;
}

/** Below this, a category is broken rather than unlucky. */
const PASS_FLOOR = 0.9;

/**
 * Below this the transcript is being rewritten rather than appended to.
 *
 * Clearing marks a watermark instead of rewriting cleared results precisely so
 * the prefix stays byte-identical and the provider's cache keeps hitting. If
 * that stops being true the bill roughly triples with nothing else visibly
 * wrong, so it is worth failing the eval over.
 */
const CACHE_FLOOR = 0.6;

async function main(): Promise<void> {
  loadDotEnv();

  const apiKey = process.env.PLATFORM_OPENAI_API_KEY;
  if (!apiKey) {
    console.error('PLATFORM_OPENAI_API_KEY is not set. It is read from .env at the repo root.');
    process.exit(1);
  }

  const runs = CONVERSATION_CASES.flatMap((testCase) => ARMS.map((arm) => ({ testCase, arm })));

  console.log(
    `Model ${PLATFORM_MODEL} | ${CONVERSATION_CASES.length} conversations, ` +
      `${runs.length} runs, ${runs.reduce((n, r) => n + r.testCase.turns.length, 0)} turns\n`,
  );

  const results = await pooled(runs, 4, ({ testCase, arm }) => runArm(apiKey, testCase, arm));

  console.log(
    'CASE                   ARM        PASSED  COMPACTIONS  CACHE  LENGTH  REASONING  WHY',
  );
  for (const row of results) {
    console.log(
      row.testCase.id.padEnd(23) +
        row.arm.padEnd(11) +
        (row.passed ? 'yes' : 'no').padEnd(8) +
        String(row.compactions).padEnd(13) +
        row.cacheRatio.toFixed(2).padEnd(7) +
        String(row.lengthFinishes).padEnd(8) +
        `${row.reasoningTurns}/${row.testCase.turns.length}`.padEnd(11) +
        row.why,
    );
  }

  const categories: ConversationCategory[] = ['needle', 'goal', 'tool-recall'];
  const rateOf = (category: ConversationCategory) => {
    const mine = results.filter((r) => r.testCase.category === category);
    return mine.length === 0 ? 1 : mine.filter((r) => r.passed).length / mine.length;
  };

  const meanCache = results.reduce((n, r) => n + r.cacheRatio, 0) / results.length;
  const rates = categories.map((c) => `${c} ${Math.round(rateOf(c) * 100)}%`).join('   ');
  console.log(`\n${rates}   cache ${Math.round(meanCache * 100)}%`);

  const brokenCategory = categories.find((c) => rateOf(c) < PASS_FLOOR);
  if (brokenCategory) {
    console.error(`\n${brokenCategory} is below ${PASS_FLOOR * 100}%`);
    process.exit(1);
  }
  if (meanCache < CACHE_FLOOR) {
    console.error(`\ncache hit rate is below ${CACHE_FLOOR * 100}%`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
