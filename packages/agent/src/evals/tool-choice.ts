import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAiProvider, PLATFORM_MODEL } from '@contexto/llm';
import { runAgentTurn } from '../run.js';
import type { AgentRunDeps } from '../run.js';
import { InMemoryTranscriptStore } from '../transcript/in-memory.js';
import { queryTerms, rankByTermMatches } from '../memory/search.js';
import type { EpisodicMemory, MemoryStore } from '../memory/types.js';
import { buildToolRegistry } from '../tools/builtin.js';
import { Vault } from '../vault/vault.js';
import { USER_DOC_NAME, writeDocument } from '../vault/documents.js';
import { readUserDoc } from '../vault/user-doc.js';

/**
 * Does the agent know which of its two memories to ask?
 *
 *   pnpm --filter @contexto/agent eval:tools
 *
 * There are now two, and they overlap. memory_search reads the raw exchanges
 * in Postgres; vault_search reads ContextoVault, which since conversations
 * became episodes holds a summarised, linked version of some of the same
 * material. That duplication was introduced deliberately -- the raw log and
 * the linked graph answer different questions -- but nothing has ever checked
 * whether the agent can tell which is which, and a real turn was observed
 * calling both for one question.
 *
 * Scored on two things, because only one of them is correctness. Did it answer,
 * and how many tools did it spend doing it. An agent that calls everything
 * every time is right and slow, and slow is a thing a student feels.
 */

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

interface Case {
  id: string;
  why: string;
  question: string;
  /** Any one of these in the reply counts as answered. */
  expect: string[];
  /** The one tool that should have been enough. */
  enough: 'vault_search' | 'vault_open' | 'memory_search' | 'none';
}

/**
 * Exchanges in the raw log only.
 *
 * Deliberately not school: nothing here would ever have become a vault episode,
 * so a question about it can only be answered from Postgres.
 */
const OLD_EXCHANGES = [
  'Student: i get really anxious before speaking assessments specifically\nAgent: Noted.',
  'Student: my dad drives me on tuesdays so i cant stay late\nAgent: Understood.',
  'Student: i want to do medicine so chemistry matters most to me\nAgent: Noted.',
  ...Array.from(
    { length: 11 },
    (_, i) => `Student: filler question ${i} about nothing much\nAgent: A short answer.`,
  ),
  // Last, and distinctive, so a question about it needs the window and nothing
  // else. The first version asked "what did i just ask you", and the model
  // answered -- correctly, and rather sharply -- that the last thing asked was
  // that question. The case was testing my phrasing, not its memory.
  'Student: whats the boiling point of water\nAgent: 100 degrees C at sea level.',
];

const CASES: Case[] = [
  {
    id: 'what-a-class-is',
    why: 'the page about a subject says this, and the page is named in the one they carry',
    question: 'what is my english class actually like',
    expect: ['irwin', 'essay', 'novel'],
    enough: 'vault_open',
  },
  {
    id: 'school-fact',
    why: 'a grade lives in the vault and nowhere else',
    question: 'what did mrs irwin give me on the castle portfolio',
    expect: ['6/8', '6 out of 8'],
    enough: 'vault_search',
  },
  {
    id: 'deadline-history',
    why: 'only the vault kept the value a deadline used to have',
    question: 'has the cold war essay date moved',
    expect: ['21', 'moved', 'changed'],
    enough: 'vault_search',
  },
  {
    id: 'said-in-conversation',
    why: 'never school, never an episode, so only the raw log has it',
    question: 'what did i say about tuesdays',
    expect: ['dad', 'drives', 'late'],
    enough: 'memory_search',
  },
  {
    id: 'personal-preference',
    why: 'a thing about them rather than about their school',
    question: 'whats my thing about speaking assessments',
    expect: ['anxious', 'anxiety', 'nervous'],
    enough: 'memory_search',
  },
  {
    id: 'in-the-window',
    why: 'the last few exchanges ride along already and need no tool at all',
    question: 'what did you tell me about the boiling point',
    expect: ['100'],
    enough: 'none',
  },
];

function seededMemory(exchanges: string[]): MemoryStore {
  const base = new Date('2026-08-01T09:00:00Z').getTime();
  const entries: EpisodicMemory[] = exchanges.map((content, i) => ({
    id: `m${i}`,
    agentId: 'eval',
    kind: 'conversation',
    content,
    source: 'agent_run',
    occurredAt: new Date(base + i * 3_600_000),
    createdAt: new Date(base + i * 3_600_000),
  }));

  return {
    record: async () => entries[0] as EpisodicMemory,
    recall: async (_id, options = {}) => ({
      summaries: [],
      recent: entries.slice(-(options.limit ?? 8)),
    }),
    search: async (_id, query, limit = 8) =>
      rankByTermMatches(entries, queryTerms(query)).slice(0, limit),
    unsummarized: async () => [],
    saveSummary: async () => {
      throw new Error('unused');
    },
  };
}

async function seedVault(root: string): Promise<Vault> {
  const vault = new Vault(root, 'eval');
  const entity = (name: string, description: string, body: string) =>
    vault.write({ name, kind: 'entity', source: 'classroom', description, body });

  await entity('enriched-english-10', 'Course', 'Enriched English 10, on Google Classroom.');
  await entity('history', 'Course', 'History, on Google Classroom.');
  await entity(
    'castle-portfolio',
    'Assignment',
    'We Have Always Lived in the Castle Portfolio.\n\nPart of [[enriched-english-10]].',
  );
  await entity(
    'cold-war-essay',
    'Assignment',
    'Cold War essay.\n\nPart of [[history]].\nDue: 2026-09-21\nWas due 2026-09-14.',
  );

  await vault.write({
    name: '2026-06-18-castle-portfolio-graded',
    kind: 'episode',
    source: 'gmail',
    description: 'Mrs Irwin graded the Castle portfolio 6/8.',
    occurred: '2026-06-18T13:03:00Z',
    actor: 'Mrs Irwin',
    event: 'assignment-graded',
    body: 'Mrs Irwin graded the Castle portfolio and gave it 6/8.\n\nAbout [[castle-portfolio]]\nIn [[enriched-english-10]]',
  });
  await vault.write({
    name: '2026-09-02-cold-war-moved',
    kind: 'episode',
    source: 'gmail',
    description: 'Mrs Bell moved the Cold War essay to the 21st.',
    occurred: '2026-09-02T10:00:00Z',
    actor: 'Mrs Bell',
    event: 'deadline-changed',
    body: 'Mrs Bell moved the Cold War essay from the 14th to the 21st.\n\nAbout [[cold-war-essay]]\nIn [[history]]',
  });

  /*
   * And the layer an agent actually reads.
   *
   * Without these the eval measures a system that no longer exists: one where
   * everything about a student had to be searched for, because there was
   * nothing naming what could be opened instead.
   */
  await writeDocument(vault, {
    name: 'class-english',
    description: 'english, as the vault has it',
    academic: true,
    body: [
      '# English',
      '',
      'Enriched English 10, taught by Mrs Irwin.',
      '',
      '## How it works',
      '',
      'Essays and portfolios on the novels studied, marked out of eight.',
    ].join('\n'),
  });

  await writeDocument(vault, {
    name: USER_DOC_NAME,
    description: 'Who this student is, and what else there is to open',
    student: 'the student',
    body: ['# The student', '', '## What they study', '', '- [[class-english]] — English'].join(
      '\n',
    ),
  });

  return vault;
}

interface Outcome {
  testCase: Case;
  reply: string;
  called: string[];
  answered: boolean;
  efficient: boolean;
}

async function runCase(apiKey: string, testCase: Case): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), 'tool-choice-'));
  try {
    const vault = await seedVault(root);
    const provider = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });
    const called: string[] = [];

    const deps = {
      llm: { chat: provider.chat.bind(provider) },
      memory: seededMemory(OLD_EXCHANGES),
      skills: { list: async () => [] },
      // The real registry, so this measures the tools an agent actually has.
      tools: buildToolRegistry(null, []),
      transcript: new InMemoryTranscriptStore(),
    } as unknown as AgentRunDeps;

    const { reply } = await runAgentTurn(deps, {
      userId: 'eval',
      agentId: 'eval',
      purpose: 'keep me on top of my a-levels',
      message: testCase.question,
      timezone: 'Europe/London',
      vault,
      // The real turn always carries this, and it is what names the pages.
      about: (await readUserDoc(vault)) ?? undefined,
      onActivity: (activity: { kind: string; name?: string }) => {
        if (activity.kind === 'tool' && activity.name) called.push(activity.name);
      },
    } as never);

    const text = reply.toLowerCase().replace(/[‘’]/g, "'");
    const answered = testCase.expect.some((want) => text.includes(want.toLowerCase()));

    const distinct = [...new Set(called)];
    // skill_load is the agent reading its own instructions, not a memory it
    // asked. Shown, so a run says what happened, and not counted as a spare
    // lookup -- the question here is which memory it chose.
    const looked = distinct.filter((tool) => tool !== 'skill_load');
    const efficient = testCase.enough === 'none' ? looked.length === 0 : looked.length <= 1;

    return { testCase, reply, called: distinct, answered, efficient };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  loadDotEnv();

  const apiKey = process.env.PLATFORM_OPENAI_API_KEY;
  if (!apiKey) {
    console.error('PLATFORM_OPENAI_API_KEY is not set. It is read from .env at the repo root.');
    process.exit(1);
  }

  console.log(`Model ${PLATFORM_MODEL} | two overlapping memories, one question at a time\n`);

  const results: Outcome[] = [];
  for (const testCase of CASES) results.push(await runCase(apiKey, testCase));

  console.log('CASE                  ANSWERED  ENOUGH          CALLED');
  for (const { testCase, answered, efficient, called } of results) {
    console.log(
      testCase.id.padEnd(22) +
        (answered ? 'yes' : 'NO').padEnd(10) +
        testCase.enough.padEnd(16) +
        (called.join(', ') || 'none') +
        (efficient ? '' : '  <- more than needed'),
    );
  }

  const answered = results.filter((r) => r.answered).length;
  const efficient = results.filter((r) => r.efficient).length;
  console.log(
    `\n${answered}/${results.length} answered, ${efficient}/${results.length} without spending a spare tool call`,
  );

  for (const outcome of results.filter((r) => !r.answered)) {
    console.log(`\n--- ${outcome.testCase.id}: ${outcome.testCase.why}`);
    console.log(outcome.reply.slice(0, 260).replace(/\s+/g, ' '));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
