import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { OpenAiProvider, PLATFORM_MODEL } from '@contexto/llm';
import type { ChatMessage } from '@contexto/llm';
import { buildSystemPrompt, buildTurnContext, buildUserMessage } from '../run.js';
import { RESPONDING } from '../prompts/documents.js';
import { InMemoryTranscriptStore } from '../transcript/in-memory.js';
import { renderTranscript } from '../transcript/render.js';
import { EVAL_CASES } from './cases.js';
import { FORMATTING_RULES, checkReply, type Severity } from './rules.js';

/**
 * Does responding.md actually change how the agent writes?
 *
 * Not a unit test. This spends real money against a real model and gives a
 * number rather than a pass or a fail, so it lives outside the suite and is
 * run deliberately:
 *
 *   pnpm --filter @contexto/agent eval
 *
 * Three arms, because there are two separate questions and answering only the
 * first would be misleading:
 *
 *   without  -- the prompt as it was before 23 Aug. The baseline.
 *   with     -- the prompt as production runs it today.
 *   polluted -- production, plus the twenty raw transcripts a real student's
 *               agent carries after a week of use. Those transcripts are the
 *               agent's own past replies, so if they are full of markdown they
 *               are twenty worked examples arguing against the document. This
 *               arm measures whether the document survives its own history.
 *
 * The gap between `with` and `without` is what the document is worth. The gap
 * between `with` and `polluted` is what the memory replay costs.
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
 * What a week of the agent talking like a document looks like in memory.
 *
 * Written by hand rather than pulled from a real account: the point is a
 * controlled dose of exactly the formatting the document forbids, so the arm
 * measures one variable. Every reply here is the kind of thing the agent
 * produced before 23 Aug.
 */
const POLLUTED_HISTORY: string[] = [
  'Student: whats due this week\nAgent: Here is what you have coming up:\n\n' +
    '| Subject | Task | Due |\n| --- | --- | --- |\n| Chemistry | Titration writeup | Wed |\n' +
    '| History | Essay plan | Fri |',
  'Student: help me with q4\nAgent: **Step 1:** Rearrange the equation.\n\n' +
    'We know that \\( v^2 = u^2 + 2as \\), so:\n\n\\[ a = \\frac{v^2 - u^2}{2s} \\]',
  'Student: explain osmosis\nAgent: ## Osmosis\n\n' +
    '- Water moves across a **semi-permeable membrane**\n' +
    '- It moves from *high* water potential to *low*\n- This continues until equilibrium',
  'Student: when is the chem test\nAgent: Great question! Based on what I can see, ' +
    'your Chemistry test is on **Thursday 14th**. Would you like me to build you a revision plan?',
  'Student: whats the formula for kinetic energy\nAgent: The formula is:\n\n' +
    '\\[ E_k = \\frac{1}{2}mv^2 \\]\n\nWhere:\n- \\( m \\) is mass in kg\n- \\( v \\) is velocity in m/s',
  "Student: i failed my mock\nAgent: I'm sorry to hear that! 😔 Here are some things that might help:\n\n" +
    '1. **Review the paper** - work out where the marks went\n2. **Talk to your teacher**\n' +
    '3. **Adjust your revision** - focus on weak topics',
  'Student: summarise chapter 3\nAgent: ### Chapter 3 Summary\n\n' +
    '**Main argument:** The author claims that industrialisation was uneven.\n\n' +
    '**Key evidence:**\n- Regional wage data\n- Census records',
  'Student: how do i cite a website\nAgent: Sure! Here is the format:\n\n' +
    '```\nAuthor, A. (Year). Title. Site. URL\n```\n\nWould you like me to format one for you?',

  /*
   * Direct mirrors of cases in the corpus.
   *
   * The first eight entries are markdown-heavy in general. These twelve answer
   * the specific questions the eval is about to ask, in the forbidden style --
   * the strongest form of the "examples beat instructions" pressure, because
   * the model can pattern-match a prior answer to the exact question rather
   * than merely absorbing a register.
   */
  'Student: how do i find the derivative of x^2\nAgent: Using the power rule:\n\n' +
    '\\[ \\frac{d}{dx} x^2 = 2x \\]\n\nBring the exponent down and reduce it by one.',
  'Student: whats the quadratic formula\nAgent: **The quadratic formula is:**\n\n' +
    '\\[ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\]',
  'Student: difference between mitosis and meiosis\nAgent: ' +
    '| Feature | Mitosis | Meiosis |\n| --- | --- | --- |\n| Divisions | 1 | 2 |\n' +
    '| Daughter cells | 2 | 4 |\n| Genetically | Identical | Varied |',
  'Student: causes of ww1\nAgent: ## Causes of World War I\n\n' +
    '### 1. Militarism\nThe arms race between Britain and Germany.\n\n' +
    '### 2. Alliances\nTwo opposing blocs.\n\n### 3. Imperialism\nCompetition for colonies.',
  'Student: how does photosynthesis work\nAgent: ### Photosynthesis\n\n' +
    'The overall equation is:\n\n\\[ 6CO_2 + 6H_2O \\rightarrow C_6H_{12}O_6 + 6O_2 \\]\n\n' +
    '**Two stages:**\n- Light-dependent reactions\n- The Calvin cycle',
  'Student: help me plan revision\nAgent: Here is a **2-week plan**:\n\n' +
    '1. **Days 1-3:** Past papers\n2. **Days 4-7:** Weak topics\n3. **Days 8-11:** Timed practice\n' +
    '4. **Days 12-14:** Light review',
  'Student: how do i write a for loop in python\nAgent: Here you go:\n\n' +
    '```python\nfor i in range(10):\n    print(i)\n```\n\nWould you like me to explain range()?',
  'Student: main themes in macbeth\nAgent: **Key themes:**\n\n' +
    '- **Ambition** - the driving force of the play\n- **Guilt** - see the sleepwalking scene\n' +
    '- **Fate vs free will** - the witches',
  'Student: whats the capital of australia\nAgent: Great question! The capital of Australia is ' +
    '**Canberra** 🇦🇺 - not Sydney, which is a common misconception!',
  'Student: explain standard deviation\nAgent: ### Standard Deviation\n\n' +
    'It is given by:\n\n\\[ \\sigma = \\sqrt{\\frac{\\sum(x_i - \\mu)^2}{N}} \\]',
  'Student: how should i structure a history essay\nAgent: **Essay structure:**\n\n' +
    '1. **Introduction** - state your argument\n2. **Body paragraphs** - one point each\n' +
    '3. **Conclusion** - restate and resolve',
  'Student: im stressed\nAgent: I hear you! 💙 Here are a few things that might help:\n\n' +
    '- **Take a break** - even 10 minutes\n- **Break it down** - one task at a time\n' +
    '- **Talk to someone**\n\nWould you like me to help you prioritise?',
];

/**
 * The same dose, as the conversation the turn replays.
 *
 * Stored as the agent's own replies rather than as a block of remembered text,
 * because that is what the pressure now is: twenty assistant messages in its
 * own voice, immediately above the question it is being asked.
 */
async function pollutedHistory(): Promise<ChatMessage[]> {
  const transcript = new InMemoryTranscriptStore();
  for (const row of POLLUTED_HISTORY) {
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
  return renderTranscript(await transcript.load('eval'));
}

const PURPOSE = 'keep me on top of my a-levels and stop me missing deadlines';
const TIMEZONE = 'Europe/London';

interface Arm {
  name: string;
  blurb: string;
  system: string;
  /** What the conversation had already said, replayed before the question. */
  history: ChatMessage[];
  /** The student's message, with this turn's context in front of it. */
  user: (message: string) => string;
}

async function arms(): Promise<Arm[]> {
  const withDoc = buildSystemPrompt(PURPOSE, []);

  // Removing the document from the assembled prompt, rather than assembling a
  // different prompt, keeps every other section byte-identical between arms.
  const withoutDoc = withDoc.replace(`${RESPONDING.body}\n\n`, '');
  if (withoutDoc === withDoc) {
    throw new Error(
      'Could not remove responding.md from the prompt -- the arms would be identical',
    );
  }

  const turn = (message: string) => buildUserMessage(buildTurnContext(TIMEZONE), message);

  return [
    {
      name: 'without',
      blurb: 'prompt as it was before 23 Aug',
      system: withoutDoc,
      history: [],
      user: turn,
    },
    { name: 'with', blurb: 'production today', system: withDoc, history: [], user: turn },
    {
      name: 'polluted',
      blurb: `production + ${POLLUTED_HISTORY.length} markdown-heavy past replies`,
      system: withDoc,
      // The history is now the conversation itself rather than a block of
      // remembered text, which is where production puts it. Same dose.
      history: await pollutedHistory(),
      user: turn,
    },
  ];
}

interface Result {
  arm: string;
  caseId: string;
  reply: string;
  ruleIds: string[];
}

/** Run tasks with a small pool, so one slow call does not serialise the run. */
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

function bar(value: number, max: number, width = 24): string {
  if (max === 0) return '';
  return '█'.repeat(Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)));
}

async function main(): Promise<void> {
  loadDotEnv();

  const apiKey = process.env.PLATFORM_OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      'PLATFORM_OPENAI_API_KEY is not set.\n' +
        'It is read from .env at the repo root, the same file the API uses.',
    );
    process.exit(1);
  }

  const provider = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });
  const armList = await arms();
  const jobs = armList.flatMap((arm) => EVAL_CASES.map((c) => ({ arm, case: c })));

  console.log(
    `Model ${PLATFORM_MODEL} | ${EVAL_CASES.length} cases x ${armList.length} arms = ${jobs.length} calls\n`,
  );
  for (const arm of armList) {
    console.log(`  ${arm.name.padEnd(9)} ${arm.blurb} (${Math.round(arm.system.length / 4)} tok)`);
  }
  console.log('\nrunning...\n');

  const results = await pooled(jobs, 5, async (job): Promise<Result> => {
    const response = await provider.chat(
      {
        messages: [
          { role: 'system', content: job.arm.system },
          ...job.arm.history,
          { role: 'user', content: job.arm.user(job.case.message) },
        ],
      },
      { userId: 'eval', agentId: 'eval' },
    );
    const reply = typeof response.content === 'string' ? response.content : '';
    return {
      arm: job.arm.name,
      caseId: job.case.id,
      reply,
      ruleIds: checkReply(reply).map((h) => h.rule.id),
    };
  });

  // ---- headline: how many replies were completely clean ----
  const severityOf = new Map(FORMATTING_RULES.map((r) => [r.id, r.severity] as const));
  const countBy = (arm: string, sev: Severity) =>
    results
      .filter((r) => r.arm === arm)
      .reduce((n, r) => n + r.ruleIds.filter((id) => severityOf.get(id) === sev).length, 0);

  console.log('ARM        CLEAN REPLIES        RENDERING  VOICE');
  for (const arm of armList) {
    const mine = results.filter((r) => r.arm === arm.name);
    const clean = mine.filter((r) => r.ruleIds.length === 0).length;
    const pct = Math.round((clean / mine.length) * 100);
    console.log(
      arm.name.padEnd(10) +
        `${String(clean).padStart(2)}/${mine.length} ${String(pct).padStart(3)}%  ` +
        bar(clean, mine.length).padEnd(26) +
        String(countBy(arm.name, 'rendering')).padStart(6) +
        String(countBy(arm.name, 'voice')).padStart(7),
    );
  }

  // ---- per-rule breakdown ----
  console.log('\nVIOLATIONS BY RULE            ' + armList.map((a) => a.name.padStart(9)).join(''));
  for (const rule of FORMATTING_RULES) {
    const counts = armList.map(
      (arm) => results.filter((r) => r.arm === arm.name && r.ruleIds.includes(rule.id)).length,
    );
    if (counts.every((c) => c === 0)) continue;
    console.log(
      `${rule.severity === 'rendering' ? '!' : ' '} ${rule.id.padEnd(28)}` +
        counts.map((c) => String(c).padStart(9)).join(''),
    );
  }

  // ---- worst offenders, so the numbers stay legible as behaviour ----
  console.log('\nWORST CASES (production arm)');
  const production = results
    .filter((r) => r.arm === 'with' && r.ruleIds.length > 0)
    .sort((a, b) => b.ruleIds.length - a.ruleIds.length)
    .slice(0, 5);
  if (production.length === 0) {
    console.log('  none -- every reply was clean');
  }
  for (const r of production) {
    console.log(`  ${r.caseId.padEnd(18)} ${r.ruleIds.join(', ')}`);
    console.log(`  ${' '.repeat(18)} ${r.reply.slice(0, 90).replace(/\s+/g, ' ')}...`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
