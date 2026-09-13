import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAiProvider, PLATFORM_MODEL } from '@contexto/llm';
import type { ChatMessage } from '@contexto/llm';
import { buildSystemPrompt, buildTurnContext, buildUserMessage } from '../run.js';
import { InMemoryTranscriptStore } from '../transcript/in-memory.js';
import { renderTranscript } from '../transcript/render.js';
import type { SkillRegistry } from '../skills/types.js';

/**
 * What it costs to keep volatile text in the system prompt.
 *
 *   pnpm --filter @contexto/agent eval:cache
 *
 * The finding this exists to hold onto: on the Responses API the system prompt
 * is cached as a whole blob keyed on its exact text, not prefix-matched.
 * Appending six tokens to a 3,613-token prompt took `cached_tokens` from 3,610
 * to zero. So while the clock and the memory block lived in the system prompt,
 * every turn rewrote it and nothing in it ever cached -- not the sections below
 * the clock, the whole thing.
 *
 * Method. Caching pays on a conversation's second turn: the first writes, the
 * second reads. Each arm sends two turns, the second carrying one more
 * remembered exchange, exactly as a real conversation would. What we read is
 * `cachedInputTokens` on turn two.
 *
 * Each arm is salted with a unique id so the arms cannot read each other's
 * cache and report someone else's win as their own.
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

const PURPOSE = 'keep me on top of my a-levels and stop me missing deadlines';
const TIMEZONE = 'Europe/London';
const QUESTION = 'what is the capital of australia';

const SKILLS = [
  {
    name: 'chase-a-missing-mark',
    description: 'Find out why a submitted assignment has no grade yet',
    instructions:
      'Check Classroom for the submission state first. If it is turned in and ungraded, ' +
      'look at the due date and the teacher announcements before drafting anything. Only ' +
      'suggest emailing the teacher if it has been more than a fortnight.',
  },
  {
    name: 'build-a-revision-plan',
    description: 'Turn an exam timetable into a day-by-day revision schedule',
    instructions:
      'Work backwards from each exam date. Reserve the last two days before any paper for ' +
      'past questions rather than new content, and never schedule more than two subjects ' +
      'in one evening.',
  },
] as unknown as Awaited<ReturnType<SkillRegistry['list']>>;

/** The conversation so far, as a turn would replay it. */
async function history(exchanges: number): Promise<ChatMessage[]> {
  const transcript = new InMemoryTranscriptStore();
  for (let i = 0; i < exchanges; i += 1) {
    const turnId = randomUUID();
    await transcript.append([
      {
        agentId: 'eval',
        turnId,
        payload: { kind: 'user', content: `question number ${i} about chemistry coursework` },
      },
      {
        agentId: 'eval',
        turnId,
        payload: {
          kind: 'assistant',
          content:
            'a reply of ordinary length about the coursework, roughly what a real turn produces',
        },
      },
    ]);
  }
  return renderTranscript(await transcript.load('eval'));
}

/** The same exchanges pasted into the prompt, which is what the arms compare. */
function pasted(messages: ChatMessage[]): string {
  return 'Recently:\n' + messages.map((m) => `- ${m.role}: ${m.content}`).join('\n');
}

interface Turn {
  system: string;
  /** Everything after the system prompt, in order, ending in this turn's question. */
  messages: ChatMessage[];
}

interface Arm {
  name: string;
  note: string;
  turns: [Turn, Turn];
}

async function arms(): Promise<Arm[]> {
  const salt = () => `Session ${randomUUID()}.\n\n`;
  const system = buildSystemPrompt(PURPOSE, SKILLS);
  const clock = buildTurnContext(TIMEZONE);
  const [six, seven] = await Promise.all([history(6), history(7)]);

  const beforeSalt = salt();
  const afterSalt = salt();
  const question = (content: string): ChatMessage[] => [{ role: 'user', content }];

  return [
    {
      name: 'before',
      note: 'clock + history inside the system prompt',
      turns: [
        {
          system: `${beforeSalt}${system}\n\n${pasted(six)}\n\n${clock}`,
          messages: question(QUESTION),
        },
        {
          system: `${beforeSalt}${system}\n\n${pasted(seven)}\n\n${clock}`,
          messages: question(QUESTION),
        },
      ],
    },
    {
      name: 'after',
      note: 'system prompt static, volatile in the turn',
      turns: [
        {
          system: afterSalt + system,
          messages: [...six, ...question(buildUserMessage(clock, QUESTION))],
        },
        {
          system: afterSalt + system,
          messages: [...seven, ...question(buildUserMessage(clock, QUESTION))],
        },
      ],
    },
  ];
}

async function main(): Promise<void> {
  loadDotEnv();

  const apiKey = process.env.PLATFORM_OPENAI_API_KEY;
  if (!apiKey) {
    console.error('PLATFORM_OPENAI_API_KEY is not set. It is read from .env at the repo root.');
    process.exit(1);
  }

  const provider = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });
  const ask = async (turn: Turn) => {
    const response = await provider.chat(
      { messages: [{ role: 'system', content: turn.system }, ...turn.messages] },
      { userId: 'eval', agentId: 'eval' },
    );
    return response.usage;
  };

  console.log(`Model ${PLATFORM_MODEL}. Two turns per arm; turn two is what caching pays for.\n`);

  const results: { arm: Arm; input: number; cached: number }[] = [];
  for (const arm of await arms()) {
    // Sequential, same arm first: turn two can only read what turn one wrote.
    await ask(arm.turns[0]);
    const usage = await ask(arm.turns[1]);
    results.push({ arm, input: usage.inputTokens, cached: usage.cachedInputTokens });
  }

  console.log('ARM     WHERE THE VOLATILE TEXT LIVES              INPUT   CACHED    HIT');
  for (const { arm, input, cached } of results) {
    const pct = input > 0 ? Math.round((cached / input) * 100) : 0;
    console.log(
      arm.name.padEnd(8) +
        arm.note.padEnd(44) +
        String(input).padStart(5) +
        String(cached).padStart(9) +
        `${String(pct).padStart(6)}%`,
    );
  }

  const before = results.find((r) => r.arm.name === 'before');
  const after = results.find((r) => r.arm.name === 'after');
  if (before && after) {
    console.log(
      `\n${after.cached - before.cached} more tokens served from cache on every turn after the first.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
