import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAiProvider, PLATFORM_MODEL } from '@contexto/llm';
import { runAgentTurn } from '../run.js';
import type { AgentRunDeps } from '../run.js';
import { InMemoryTranscriptStore } from '../transcript/in-memory.js';
import { buildToolRegistry } from '../tools/builtin.js';
import type { PortalSnapshotSource, ToolContext } from '../tools/types.js';
import { USER_DOC_NAME, writeDocument } from '../vault/documents.js';
import { readUserDoc } from '../vault/user-doc.js';
import { Vault } from '../vault/vault.js';

/**
 * Does the agent load a skill when the turn needs one, and only then?
 *
 *   pnpm --filter @contexto/agent eval:skills
 *
 * The skills used to be paragraphs of the system prompt, always present.
 * Now the prompt names them and the model decides. That decision is the
 * whole feature, and it fails silently in both directions: a vault question
 * answered without the reading rules is answered worse, and a sum that loads
 * three skills first is a sum the student waits for.
 *
 * Scored on four things per case. Loaded what it should. Loaded nothing it
 * should not. Called the right tool. Answered.
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

type SkillName =
  | 'browser'
  | 'vault-reading'
  | 'vault-writing'
  | 'tutoring'
  | 'reading'
  | 'problem-solving'
  | 'practice'
  | 'feedback'
  | 'study-skills'
  | 'writing'
  | 'research'
  | 'presenting'
  | 'data'
  | 'brainstorming'
  | 'planning'
  | 'progress'
  | 'communication'
  | 'admin'
  | 'group-work'
  | 'submitting'
  | 'applications'
  | 'decisions'
  | 'wellbeing';

interface Case {
  id: string;
  why: string;
  question: string;
  /** Whether the student has a vault, which decides which skills exist. */
  vault: boolean;
  /** Every one of these must be loaded. */
  load: SkillName[];
  /** None of these may be loaded. 'any' means no skill at all. */
  noLoad: SkillName[] | 'any';
  /** At least one of these must be called. */
  tool?: string[];
  /** None of these may be called. */
  noTool?: string[];
  /** Any one of these in the reply counts as answered. */
  expect?: string[];
  /** For a write: an episode with this event, linking About this note. */
  written?: { event: string; about: string };
}

const CASES: Case[] = [
  {
    id: 'arithmetic-no-vault',
    why: 'nothing here is about the vault or a site, and there is no vault anyway',
    question: 'whats 15% of 240',
    vault: false,
    load: [],
    noLoad: 'any',
    noTool: ['skill_load'],
    expect: ['36'],
  },
  {
    id: 'greeting-with-vault',
    why: 'a vault exists, and the turn still has no use for it',
    question: 'hey hows it going',
    vault: true,
    load: [],
    noLoad: 'any',
    noTool: ['skill_load', 'vault_search', 'vault_open'],
  },
  {
    id: 'what-a-teacher-said',
    why: 'the words are in an episode, and the reading rules say how to get there',
    question: 'what did mrs irwin say about my castle portfolio',
    vault: true,
    load: ['vault-reading'],
    noLoad: ['browser', 'vault-writing'],
    tool: ['vault_search'],
    expect: ['6/8', '6 out of 8', 'six out of eight'],
  },
  {
    id: 'what-a-class-is',
    why: 'the page about a subject says this, and it is opened by name',
    question: 'what is my english class actually like',
    vault: true,
    load: ['vault-reading'],
    noLoad: ['browser', 'vault-writing'],
    tool: ['vault_open'],
    expect: ['irwin', 'essay', 'novel'],
  },
  {
    id: 'a-test-moved',
    why: 'only the student knows this, and the vault should too by the end of the turn',
    question: 'just so you know the chemistry test got moved to friday the 25th',
    vault: true,
    load: ['vault-writing'],
    noLoad: ['browser'],
    tool: ['vault_write'],
    written: { event: 'deadline-changed', about: 'chemistry-test' },
  },
  {
    id: 'check-the-portal',
    why: 'a connected site is the browser skill, and the snapshot already answers it',
    question: 'can you check veracross and see if anything new is due',
    vault: true,
    load: ['browser'],
    noLoad: ['vault-writing'],
    tool: ['portal_read', 'portal_refresh'],
    expect: ['thursday', '18'],
  },
  // No answer check: it would ride on a live fetch of example.com, which one
  // run already failed on DNS alone. The tool choice is the measurement.
  {
    id: 'a-public-article',
    why: 'a public page is a plain fetch, and waking a laptop for it is the wrong call',
    question: 'whats on https://example.com',
    vault: true,
    load: [],
    noLoad: ['browser', 'vault-writing'],
    tool: ['web_read_link'],
    noTool: ['browser_open'],
  },
  {
    id: 'a-page-behind-a-login',
    why: 'only their browser has the session, so only the browser skill applies',
    question:
      'open https://portal.school.example/grades in my browser and tell me if my chemistry grade is in yet',
    vault: true,
    load: ['browser'],
    noLoad: ['vault-writing'],
    tool: ['browser_open'],
    expect: ['84'],
  },

  /*
   * The twenty general skills, one case each.
   *
   * Every question is written to sit squarely in one skill and near the edge
   * of its closest neighbour, and `noLoad` names that neighbour. Passing means
   * the trigger lines keep the twenty apart, which is the only thing that
   * makes a catalog this size better than a shorter one.
   */
  {
    id: 'a-concept-not-landed',
    why: 'an idea in general, not a text and not an exercise: tutoring',
    question: 'i dont get how photosynthesis actually works, can you explain it to me',
    vault: true,
    load: ['tutoring'],
    noLoad: ['problem-solving', 'practice', 'reading'],
  },
  {
    id: 'a-passage-to-unpack',
    why: 'a specific text they have, to be understood: reading, not tutoring',
    question:
      'this is from my textbook and i cant follow it: "The mitochondrial membrane potential, ' +
      'generated by the electron transport chain, drives ATP synthase through chemiosmosis." ' +
      'what is it actually saying',
    vault: true,
    load: ['reading'],
    noLoad: ['tutoring', 'practice'],
  },
  {
    id: 'an-attempt-to-check',
    why: 'one specific question with their attempt: problem-solving, and the answer is 7',
    question: 'for 3x + 5 = 26 i got x = 6, is that right? if not show me where i went wrong',
    vault: true,
    load: ['problem-solving'],
    noLoad: ['tutoring', 'practice'],
    expect: ['7'],
  },
  {
    id: 'quiz-me',
    why: 'testing themselves on a topic: practice',
    question: 'quiz me on the french revolution, one question at a time',
    vault: true,
    load: ['practice'],
    noLoad: ['tutoring', 'planning'],
  },
  {
    id: 'a-paragraph-they-wrote',
    why: 'something they made, judged: feedback, not writing',
    question:
      'this is the intro to my history essay: "The French Revolution was very important and ' +
      'changed many things. In this essay I will talk about the causes." be honest, how do i ' +
      'make it better',
    vault: true,
    load: ['feedback'],
    noLoad: ['writing', 'progress'],
  },
  {
    id: 'how-to-study',
    why: 'the method, not the studying and not the schedule: study-skills',
    question: 'i keep rereading my notes but nothing sticks, how should i actually study for bio',
    vault: true,
    load: ['study-skills'],
    noLoad: ['practice', 'planning', 'wellbeing'],
  },
  {
    id: 'start-the-essay',
    why: 'producing a piece of writing from nothing: writing',
    question:
      'help me write my english essay on we have always lived in the castle, i dont know where to start',
    vault: true,
    load: ['writing'],
    noLoad: ['feedback', 'communication'],
  },
  {
    id: 'sources-with-citations',
    why: 'finding and citing information for their work: research',
    question:
      'i need three good sources on the causes of world war one for my essay, with mla citations',
    vault: true,
    load: ['research'],
    noLoad: ['reading', 'brainstorming'],
  },
  {
    id: 'a-talk-next-week',
    why: 'something shown to an audience: presenting, not writing',
    question:
      'i have to give a five minute talk on climate change next week, help me plan the slides',
    vault: true,
    load: ['presenting'],
    noLoad: ['writing', 'feedback'],
  },
  {
    id: 'lab-results',
    why: 'many values, not one problem: data',
    question:
      'my pendulum lab times were 2.3s, 2.5s, 2.1s and 9.8s. what should i do with these and ' +
      'whats the average',
    vault: true,
    load: ['data'],
    noLoad: ['problem-solving', 'writing'],
  },
  {
    id: 'project-ideas',
    why: 'inventing options, not finding or developing them: brainstorming',
    question: 'i need ideas for my science fair project, something to do with plants',
    vault: true,
    load: ['brainstorming'],
    noLoad: ['writing', 'research'],
  },
  {
    id: 'the-week-ahead',
    why: 'what is due and how to spread it: planning',
    question: 'what do i have due this week and how should i spread it out',
    vault: true,
    load: ['planning'],
    noLoad: ['progress', 'study-skills'],
  },
  {
    id: 'where-they-stand',
    why: 'where they stand and what a target needs: progress, not planning',
    question:
      'how am i doing in english this term and what do i need on the next portfolio to get an A',
    vault: true,
    load: ['progress'],
    noLoad: ['planning', 'feedback'],
  },
  {
    id: 'an-email-to-a-teacher',
    why: 'a message to a person: communication, not the procedure and not writing',
    question:
      'can you write an email to mr ali asking to move my chemistry test, ive been sick all week',
    vault: true,
    load: ['communication'],
    noLoad: ['admin', 'writing'],
  },
  {
    id: 'how-extensions-work',
    why: 'the procedure, not the message: admin',
    question: 'how do extensions actually work at my school, whats the process',
    vault: true,
    load: ['admin'],
    noLoad: ['communication', 'applications'],
  },
  {
    id: 'partners-not-pulling-weight',
    why: 'the coordination of a group, not their own part: group-work',
    question: 'my group project partners arent doing anything and its due in a week, what do i do',
    vault: true,
    load: ['group-work'],
    // Communication is tolerated here, not required: three runs in a row
    // loaded it alongside, because a message to the partners is a real part
    // of the answer. The trigger lines already draw the line; forbidding it
    // would fail a case on a judgement the model is entitled to make.
    noLoad: ['writing'],
  },
  {
    id: 'ready-to-hand-in',
    why: 'the hand-in itself: submitting',
    question: 'i finished my castle portfolio, can you check its ready and turn it in for me',
    vault: true,
    load: ['submitting'],
    noLoad: ['planning', 'writing'],
  },
  {
    id: 'a-summer-programme',
    why: 'applying somewhere, not the school’s own process: applications',
    question: 'i want to apply for a summer research program, where do i even start',
    vault: true,
    load: ['applications'],
    noLoad: ['admin', 'writing'],
  },
  {
    id: 'which-course-next-year',
    why: 'choosing, not applying or planning: decisions',
    question: 'should i take ap physics or ap chem next year, i cant decide',
    vault: true,
    load: ['decisions'],
    noLoad: ['applications', 'planning'],
  },
  /*
   * Turns that need no skill at all.
   *
   * The other half of routing, and the half that costs the student most when
   * it goes wrong: a 950-word document loaded for a one-line answer is a
   * step they wait through for nothing. Each of these sits near a skill's
   * trigger without being what the trigger is for.
   */
  {
    id: 'a-quick-fact',
    why: 'a fact they could look up is not a concept to teach: no skill',
    question: 'who wrote hamlet',
    vault: true,
    load: [],
    noLoad: 'any',
    noTool: ['skill_load'],
    expect: ['shakespeare'],
  },
  {
    id: 'a-quick-definition',
    why: 'a one-line definition is not tutoring',
    question: 'what does osmosis mean, one sentence',
    vault: true,
    load: [],
    noLoad: 'any',
    noTool: ['skill_load'],
  },
  {
    id: 'thanks',
    why: 'nothing is being asked for',
    question: 'thanks, that really helped',
    vault: true,
    load: [],
    noLoad: 'any',
    noTool: ['skill_load'],
  },
  {
    id: 'a-bad-monday',
    why: 'a grumble is not a student who is not okay: no skill, and not wellbeing',
    question: 'ugh, mondays',
    vault: true,
    load: [],
    noLoad: 'any',
    noTool: ['skill_load'],
  },
  {
    id: 'days-until',
    why: 'date arithmetic is a sum, not planning',
    question: 'how many days from september 12 to september 25',
    vault: true,
    load: [],
    noLoad: 'any',
    noTool: ['skill_load'],
    expect: ['13'],
  },
  {
    id: 'not-okay',
    why: 'a person not coping, not a method problem: wellbeing',
    question:
      'honestly im so behind on everything and i havent slept properly in days, i dont know what to do',
    vault: true,
    load: ['wellbeing'],
    noLoad: ['study-skills'],
  },
];

/**
 * A linked computer that answers at once.
 *
 * One connected site with a captured page, a refresh that "signs in" and
 * returns it again, and a browse that returns a grades page. Enough for the
 * model to have something real to read, and nothing that touches a network.
 */
function fakePortals(): PortalSnapshotSource {
  const snapshot = {
    portalId: 'veracross',
    origin: 'https://portals.veracross.example',
    capturedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    redacted: false,
    pages: [
      {
        url: 'https://portals.veracross.example/student/assignments',
        title: 'Assignments',
        text: 'Upcoming: Chemistry test, Thursday 18 September. History essay plan, Friday 19 September.',
        components: [],
      },
    ],
  };
  return {
    latest: async () => [snapshot],
    requestRefresh: async () => ({ alreadyPending: false, requestId: 'refresh-1' }),
    requestBrowse: async () => ({ requestId: 'browse-1' }),
    awaitRefresh: async (requestId) => ({
      finished: true,
      outcome: requestId.startsWith('browse') ? 'read' : 'synced',
    }),
    resultOf: async () => ({
      url: 'https://portal.school.example/grades',
      title: 'Grades',
      text: 'Term grades. Chemistry: 84%. Physics: pending. History: 71%.',
      links: [],
    }),
  };
}

async function seedVault(root: string): Promise<Vault> {
  const vault = new Vault(root, 'eval');
  const entity = (name: string, description: string, body: string) =>
    vault.write({ name, kind: 'entity', source: 'classroom', description, body });

  await entity('enriched-english-10', 'Course', 'Enriched English 10, on Google Classroom.');
  await entity('chemistry', 'Course', 'Chemistry, on Google Classroom.');
  await entity(
    'castle-portfolio',
    'Assignment',
    'We Have Always Lived in the Castle Portfolio.\n\nPart of [[enriched-english-10]].',
  );
  await entity(
    'chemistry-test',
    'Assignment',
    'Chemistry test.\n\nPart of [[chemistry]].\nDue: 2026-09-18',
  );

  await vault.write({
    name: '2026-06-18-castle-portfolio-graded',
    kind: 'episode',
    source: 'gmail',
    description: 'Mrs Irwin graded the Castle portfolio 6/8.',
    occurred: '2026-06-18T13:03:00Z',
    actor: 'Mrs Irwin',
    event: 'assignment-graded',
    body: 'Mrs Irwin graded the Castle portfolio and gave it 6/8, saying the close reading was strong and the conclusion rushed.\n\nAbout [[castle-portfolio]]\nIn [[enriched-english-10]]',
  });

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
    name: 'class-chemistry',
    description: 'chemistry, as the vault has it',
    academic: true,
    body: '# Chemistry\n\nTaught by Mr Ali. Tests every few weeks, out of 100.',
  });
  await writeDocument(vault, {
    name: USER_DOC_NAME,
    description: 'Who this student is, and what else there is to open',
    student: 'the student',
    body: [
      '# The student',
      '',
      '## What they study',
      '',
      '- [[class-english]] — English',
      '- [[class-chemistry]] — Chemistry',
    ].join('\n'),
  });

  return vault;
}

interface Outcome {
  testCase: Case;
  reply: string;
  loaded: string[];
  called: string[];
  problems: string[];
}

async function runCase(apiKey: string, testCase: Case): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), 'skill-choice-'));
  try {
    const vault = testCase.vault ? await seedVault(root) : undefined;
    const provider = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });

    /*
     * The real registry, wrapped to see the arguments.
     *
     * onActivity names the tool but not what it was asked for, and the thing
     * this eval scores is which skill skill_load was asked for.
     */
    const tools = buildToolRegistry(null, []);
    const calls: { tool: string; args: string }[] = [];
    const execute = tools.execute.bind(tools);
    tools.execute = async (id: string, raw: string, ctx: ToolContext) => {
      calls.push({ tool: id, args: raw });
      return execute(id, raw, ctx);
    };

    const deps = {
      llm: { chat: provider.chat.bind(provider) },
      memory: {
        recall: async () => ({ summaries: [], recent: [] }),
        record: async () => ({}),
        search: async () => [],
      },
      skills: { list: async () => [] },
      tools,
      transcript: new InMemoryTranscriptStore(),
    } as unknown as AgentRunDeps;

    const { reply } = await runAgentTurn(deps, {
      userId: 'eval',
      agentId: 'eval',
      purpose: 'keep me on top of my a-levels',
      message: testCase.question,
      timezone: 'Europe/London',
      portals: fakePortals(),
      ...(vault ? { vault, about: (await readUserDoc(vault)) ?? undefined } : {}),
    } as never);

    const loaded = [
      ...new Set(
        calls
          .filter((call) => call.tool === 'skill_load')
          .map((call) => {
            try {
              return String((JSON.parse(call.args) as { name?: unknown }).name ?? '');
            } catch {
              return '';
            }
          }),
      ),
    ];
    const called = [...new Set(calls.map((call) => call.tool))];
    const text = reply.toLowerCase().replace(/[‘’]/g, "'");
    const problems: string[] = [];

    for (const skill of testCase.load) {
      if (!loaded.includes(skill)) problems.push(`did not load ${skill}`);
    }
    if (testCase.noLoad === 'any') {
      if (loaded.length > 0) problems.push(`loaded ${loaded.join(', ')} for nothing`);
    } else {
      for (const skill of testCase.noLoad) {
        if (loaded.includes(skill)) problems.push(`loaded ${skill} needlessly`);
      }
    }
    if (testCase.tool && !testCase.tool.some((tool) => called.includes(tool))) {
      problems.push(`called none of ${testCase.tool.join('/')}`);
    }
    for (const tool of testCase.noTool ?? []) {
      if (called.includes(tool)) problems.push(`called ${tool}`);
    }
    if (testCase.expect && !testCase.expect.some((want) => text.includes(want.toLowerCase()))) {
      problems.push(`missing any of: ${testCase.expect.join(' / ')}`);
    }
    if (testCase.written && vault) {
      const episodes = await vault.list('episode');
      const match = episodes.find(
        (note) =>
          note.source === 'student' &&
          note.event === testCase.written?.event &&
          note.body.includes(`About [[${testCase.written?.about}]]`),
      );
      if (!match) {
        problems.push(
          `no student episode with event ${testCase.written.event} About [[${testCase.written.about}]]`,
        );
      }
    }

    return { testCase, reply, loaded, called, problems };
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

  console.log(`Model ${PLATFORM_MODEL} | twenty-three skills, loaded on demand\n`);

  const results: Outcome[] = [];
  for (const testCase of CASES) results.push(await runCase(apiKey, testCase));

  console.log('CASE                     LOADED                    CALLED');
  for (const { testCase, loaded, called, problems } of results) {
    console.log(
      testCase.id.padEnd(25) +
        (loaded.join(', ') || 'none').padEnd(26) +
        (called.filter((tool) => tool !== 'skill_load').join(', ') || 'none') +
        (problems.length > 0 ? `  <- ${problems.join('; ')}` : ''),
    );
  }

  const held = results.filter((r) => r.problems.length === 0).length;
  console.log(`\n${held}/${results.length} held`);

  for (const outcome of results.filter((r) => r.problems.length > 0)) {
    console.log(`\n--- ${outcome.testCase.id}: ${outcome.testCase.why}`);
    console.log(outcome.reply.slice(0, 260).replace(/\s+/g, ' '));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
