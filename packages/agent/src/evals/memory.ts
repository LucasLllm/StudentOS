import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentActivity } from '@contexto/shared';
import { OpenAiProvider, PLATFORM_MODEL } from '@contexto/llm';
import { runAgentTurn } from '../run.js';
import type { AgentRunDeps } from '../run.js';
import { ToolRegistry } from '../tools/registry.js';
import { searchMemory } from '../tools/memory.js';
import { InMemoryTranscriptStore } from '../transcript/in-memory.js';
import type { ContextBudget } from '../transcript/budget.js';
import { tmpdir } from 'node:os';
import { collectExchanges } from '../memory/summarize.js';
import { updateChatsDoc } from '../vault/chats-doc.js';
import { readDocument, CHATS_DOC_NAME } from '../vault/documents.js';
import { Vault } from '../vault/vault.js';
import type { ProfileStore } from '../memory/profile.js';
import { queryTerms, rankByTermMatches } from '../memory/search.js';
import type { EpisodicMemory, MemoryStore, RecallOptions } from '../memory/types.js';
import { MEMORY_CASES } from './memory-cases.js';
import { gradeReply, type MemoryCase, type MemoryCategory } from './memory-grader.js';

/**
 * Can the agent remember anything that is no longer sitting in the prompt?
 *
 *   pnpm --filter @contexto/agent eval:memory
 *
 * Unlike the formatting evals, this runs a whole turn -- real tool loop, real
 * memory_search -- because the thing being measured is whether the agent
 * reaches for its history at all. Calling the model directly would test
 * whether it can read a transcript, which is not the question.
 *
 * A turn now replays the whole seeded transcript (deps.transcript), so the
 * twelve exchanges of ordinary school chatter each case buries its fact
 * behind no longer fall outside any window -- they are all still in context,
 * verbatim. Three arms:
 *
 *   - search only: the plain transcript, no profile. With everything still
 *     verbatim in context this mostly checks the agent does not need to
 *     search at all; memory_search stays available for facts the transcript
 *     alone does not carry (an earlier session, an update, an abstention).
 *   - + profile: the same transcript, plus a profile the vault's real writer
 *     produced from the same history. Measures whether a bounded always-on
 *     document beats searching for everything.
 *   - compacted: the same cases run with a budget tiny enough
 *     (compactAboveTokens: 1) that compaction fires on turn one, collapsing
 *     everything but the last two user turns into a handoff summary. This is
 *     what puts a fact out of reach again, so it is the arm that measures
 *     what the original recency-window version of this eval measured: does
 *     the agent recognise the handoff summary is incomplete and reach for
 *     memory_search to recover the fact behind it.
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
 * The Postgres store's behaviour, in memory.
 *
 * Deliberately mirrors PostgresMemoryStore rather than being convenient: most
 * recent N reversed to read oldest-first, and a case-insensitive substring
 * match ordered newest-first. If this drifts from the real one, the eval
 * measures a store that does not exist.
 */
function seededStore(history: string[], queries: { q: string; hits: number }[]): MemoryStore {
  const base = new Date('2026-08-01T09:00:00Z').getTime();
  const entries: EpisodicMemory[] = history.map((content, i) => ({
    id: `m${i}`,
    agentId: 'eval',
    kind: 'conversation',
    content,
    source: 'agent_run',
    // An hour apart, oldest first, so "recent" means something.
    occurredAt: new Date(base + i * 3_600_000),
    createdAt: new Date(base + i * 3_600_000),
  }));

  return {
    record: async () => entries[0] as EpisodicMemory,
    recall: async (_agentId: string, options: RecallOptions = {}) => ({
      summaries: [],
      recent: entries.slice(-(options.limit ?? 8)),
    }),
    search: async (_agentId: string, query: string, limit = 8) => {
      // Same ranking the Postgres store uses, so the eval measures what ships.
      const hits = rankByTermMatches(entries, queryTerms(query)).slice(0, limit);
      queries.push({ q: query, hits: hits.length });
      return hits;
    },
    unsummarized: async () => [],
    saveSummary: async () => {
      throw new Error('not used by this eval');
    },
  };
}

/**
 * The same history, as the conversation the turn now replays.
 *
 * The window the eval measures against is no longer a recall limit but the
 * transcript itself, so the case's exchanges have to be items in it: each
 * stored row is one student message and one reply, which is what the model
 * would have seen had it lived through them.
 */
async function seededTranscript(history: string[]): Promise<InMemoryTranscriptStore> {
  const transcript = new InMemoryTranscriptStore();
  for (const row of history) {
    const split = row.indexOf('\nAgent: ');
    const turnId = randomUUID();
    await transcript.append([
      {
        agentId: 'eval',
        turnId,
        payload: { kind: 'user', content: row.slice('Student: '.length, split) },
      },
      {
        agentId: 'eval',
        turnId,
        payload: { kind: 'assistant', content: row.slice(split + '\nAgent: '.length) },
      },
    ]);
  }
  return transcript;
}

/**
 * Write the chats page from this case's history, with the real writer.
 *
 * Hand-writing the page would measure a document we invented rather than the
 * one the job produces, which is the only one that will ever exist.
 */
async function profileFor(apiKey: string, testCase: MemoryCase): Promise<string> {
  const provider = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });
  const profiles: ProfileStore = {
    read: async () => ({ profile: '', updatedAt: null }),
    save: async () => {},
    stale: async () => [],
  };

  const root = mkdtempSync(join(tmpdir(), 'contexto-eval-memory-'));
  try {
    const vault = new Vault(root, 'eval');
    const burst = await collectExchanges(
      { memory: seededStore(testCase.history, []), profiles },
      { agentId: 'eval', userId: 'eval' },
    );

    await updateChatsDoc({ llm: provider }, { vault, exchanges: burst.exchanges, userId: 'eval' });

    return (await readDocument(vault, CHATS_DOC_NAME))?.body ?? '';
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface Outcome {
  testCase: MemoryCase;
  reply: string;
  passed: boolean;
  why: string;
  searched: boolean;
  queries: { q: string; hits: number }[];
}

async function runCase(
  apiKey: string,
  testCase: MemoryCase,
  profile?: string,
  contextBudget?: Partial<ContextBudget>,
): Promise<Outcome> {
  const provider = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });
  const tools = new ToolRegistry();
  tools.register(searchMemory as never);

  const queries: { q: string; hits: number }[] = [];
  const deps = {
    llm: { chat: provider.chat.bind(provider) },
    // Still the memory store, because memory_search is what this measures.
    memory: seededStore(testCase.history, queries),
    skills: { list: async () => [] },
    tools,
    transcript: await seededTranscript(testCase.history),
  } as unknown as AgentRunDeps;

  const used: string[] = [];
  const { reply } = await runAgentTurn(deps, {
    userId: 'eval',
    agentId: 'eval',
    purpose: 'keep me on top of my a-levels and stop me missing deadlines',
    message: testCase.question,
    timezone: 'Europe/London',
    ...(profile ? { about: profile } : {}),
    ...(contextBudget ? { contextBudget } : {}),
    onActivity: (a: AgentActivity) => {
      if (a.kind === 'tool' && a.name) used.push(a.name);
    },
  } as never);

  const grade = gradeReply(testCase, reply);
  return { testCase, reply, ...grade, searched: used.includes('memory_search'), queries };
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

async function main(): Promise<void> {
  loadDotEnv();

  const apiKey = process.env.PLATFORM_OPENAI_API_KEY;
  if (!apiKey) {
    console.error('PLATFORM_OPENAI_API_KEY is not set. It is read from .env at the repo root.');
    process.exit(1);
  }

  console.log(
    `Model ${PLATFORM_MODEL} | ${MEMORY_CASES.length} cases, each with its fact buried ` +
      'behind twelve exchanges of school chatter\n',
  );

  const results = await pooled(MEMORY_CASES, 4, (c) => runCase(apiKey, c));

  // Second arm: the same cases, with a profile the writer produced from the
  // same history. The question stage two has to answer is whether a bounded
  // always-on document beats searching for everything.
  console.log('writing profiles...');
  const profiles = await pooled(MEMORY_CASES, 4, (c) => profileFor(apiKey, c));
  const withProfile = await pooled(
    MEMORY_CASES.map((c, i) => ({ c, profile: profiles[i] ?? '' })),
    4,
    ({ c, profile }) => runCase(apiKey, c, profile),
  );

  // Third arm: the same cases, forced through compaction (compactAboveTokens: 1
  // guarantees it fires on turn one) so the fact sits behind a handoff summary
  // instead of a verbatim transcript. This is the arm that answers the
  // question the eval was originally built for: can the agent recover a fact
  // that is no longer sitting in context.
  const COMPACTED_BUDGET: Partial<ContextBudget> = { compactAboveTokens: 1, keepLastUserTurns: 2 };
  const compacted = await pooled(MEMORY_CASES, 4, (c) =>
    runCase(apiKey, c, undefined, COMPACTED_BUDGET),
  );

  const categories: MemoryCategory[] = [
    'continuity',
    'extraction',
    'multi-session',
    'update',
    'temporal',
    'abstention',
    'dense',
  ];

  const score = (rows: Outcome[], category: MemoryCategory) => {
    const mine = rows.filter((r) => r.testCase.category === category);
    return `${mine.filter((r) => r.passed).length}/${mine.length}`;
  };

  console.log('CATEGORY          SEARCH ONLY   + PROFILE   COMPACTED');
  for (const category of categories) {
    if (!results.some((r) => r.testCase.category === category)) continue;
    console.log(
      category.padEnd(17) +
        score(results, category).padStart(11) +
        score(withProfile, category).padStart(12) +
        score(compacted, category).padStart(12),
    );
  }

  const searchedWith = withProfile.filter((r) => r.searched).length;
  const searchedCompacted = compacted.filter((r) => r.searched).length;
  console.log(
    `\nreached for memory_search: ${results.filter((r) => r.searched).length}/${results.length}` +
      ` without a profile, ${searchedWith}/${withProfile.length} with one, ` +
      `${searchedCompacted}/${compacted.length} compacted`,
  );
  const avgProfile = Math.round(
    profiles.reduce((n, p) => n + (p?.length ?? 0), 0) / profiles.length,
  );
  console.log(`average profile: ${avgProfile}/1400 characters`);

  const pct = (rows: Outcome[]) =>
    `${rows.filter((r) => r.passed).length}/${rows.length} (${Math.round((rows.filter((r) => r.passed).length / rows.length) * 100)}%)`;
  console.log(
    `\nTOTAL            ${pct(results).padStart(10)}${pct(withProfile).padStart(13)}${pct(compacted).padStart(13)}`,
  );

  const failures = withProfile.filter((r) => !r.passed);
  if (failures.length > 0) {
    console.log('\nSTILL FAILING WITH A PROFILE');
    for (const f of failures) {
      console.log(`  ${f.testCase.id.padEnd(18)} ${f.testCase.category.padEnd(14)} ${f.why}`);
      const shown = f.queries.map((q) => `"${q.q}"->${q.hits}`).join('  ') || 'none';
      console.log(`  ${' '.repeat(18)} queries: ${shown}`);
      console.log(`  ${' '.repeat(18)} "${f.reply.slice(0, 110).replace(/\s+/g, ' ')}"`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
