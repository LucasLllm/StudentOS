import { randomUUID } from 'node:crypto';
import type { AgentActivity } from '@contexto/shared';
import type { ChatMessage, ChatResponse, LlmRegistry } from '@contexto/llm';
import { RESPONDING } from './prompts/documents.js';
import { skillsSection } from './skills/builtin.js';
import { skillRequested } from './tools/skills.js';
import { renderTranscript, renderUserItem } from './transcript/render.js';
import { truncateToolResult } from './transcript/truncate.js';
import type {
  AppendTranscriptInput,
  TranscriptPayload,
  TranscriptStore,
} from './transcript/types.js';
import type { MemoryStore } from './memory/types.js';
import type { SkillRegistry } from './skills/types.js';
import type { GoogleTokenProvider, ToolContext, PortalSnapshotSource } from './tools/types.js';
import type { AudioTranscriber } from './tools/transcribe.js';
import type { YoutubeMetadataSource, YoutubeTranscriptSource } from './tools/web/youtube.js';
import type { ToolRegistry } from './tools/registry.js';
import type { Vault } from './vault/vault.js';

/**
 * One turn of an agent.
 *
 * Replay the conversation from the transcript, add what the student just said,
 * call the model, run whatever tools it asks for, feed the results back, repeat
 * until it stops calling tools. Everything the turn produced -- replies, tool
 * calls, tool results, the model's own reasoning -- is appended to the
 * transcript at the end, because that is what the next turn replays.
 *
 * The transcript is the memory. What the agent knows about earlier in this
 * conversation is not a summary of it: it is the conversation.
 */

export interface AgentRunDeps {
  llm: LlmRegistry;
  memory: MemoryStore;
  skills: SkillRegistry;
  tools: ToolRegistry;
  transcript: TranscriptStore;
}

export interface AgentRunInput {
  userId: string;
  agentId: string;
  /** The agent's student-authored purpose. Anchors the system prompt. */
  purpose: string;
  /** The page the vault writes about them, from vault/user-doc.ts. */
  about?: string;
  message: string;
  /**
   * Files attached to this message, already read into text.
   *
   * Carried on the turn rather than left in the vault to be searched for. The
   * vault copy is what makes a file findable next month; this is what makes it
   * readable now. A student who attaches a photograph and asks "what is this"
   * has given the agent nothing to search with, and an agent answering "I
   * cannot see images" while holding the transcription of one is the whole
   * feature failing at its last step.
   */
  attachments?: { name: string; body: string }[];
  /**
   * IANA timezone. Defaults to UTC.
   *
   * Without this the agent cannot resolve "tomorrow at 3pm" into a timestamp
   * and will either interrogate the student or silently guess.
   */
  timezone?: string;
  /** Supplied when the student has connected Google. Omitted otherwise. */
  google?: GoogleTokenProvider;
  /** Supplied when the deployment can transcribe audio. Omitted otherwise. */
  transcriber?: AudioTranscriber;
  /** Supplied when the deployment can look up YouTube metadata. */
  youtube?: YoutubeMetadataSource;
  /** Supplied when the deployment has a transcript service key. */
  youtubeTranscripts?: YoutubeTranscriptSource;
  /** Supplied when a residential proxy is configured. */
  residentialFetch?: typeof globalThis.fetch;
  /** Portal snapshots pushed up by the student's linked desktop companion. */
  portals?: PortalSnapshotSource;
  /**
   * ContextoVault, when this student has one.
   *
   * Its presence also decides which skills the prompt names: an agent
   * with nothing to search should not be offered a skill about searching it.
   */
  vault?: Vault;
  /**
   * Told what the turn is doing, each time that changes.
   *
   * A notification and nothing more: the turn does not wait on it, read it
   * back, or behave differently for having one. What the caller does with it
   * -- hold it for a poll to collect, drop it -- is the caller's business.
   */
  onActivity?: (activity: AgentActivity) => void;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  reply: string;
  toolsUsed: string[];
  /**
   * The skills the turn read before answering, in order, each once.
   *
   * Beside the reply rather than only reported as it happens, because this is
   * the one step that stays on the transcript: a reply shows what it read
   * above it, the way a search assistant shows what it searched.
   */
  skillsRead: string[];
}

/**
 * Bounds the tool loop.
 *
 * A model that keeps calling tools has to terminate somewhere. Eight was sized
 * for a loop that started from nothing each iteration, where going round again
 * meant re-deriving the plan and was worth being stingy about. The model now
 * keeps its own reasoning between iterations, so an iteration is a cheap
 * continuation of one train of thought rather than a fresh start -- and cutting
 * a genuinely multi-step task off at eight costs more than letting it run.
 */
const MAX_ITERATIONS = 20;

/**
 * Reasoning tokens count against this. xhigh on a hard step can spend 10-20k
 * before a word of the answer; Luna allows 128k. Below this the answer is cut
 * mid-thought and comes back as status 'incomplete' with no text.
 */
export const AGENT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * The model's text, as a string, whatever it actually sent.
 *
 * A response carrying no text has no text field -- the OpenAI adapter passes
 * `output_text` straight through and that is simply absent when there is
 * nothing to say. Treating it as a string and calling .trim() threw, and it
 * threw in exactly the case the fallback below exists to rescue, so the turn
 * died instead of answering. Everything the model says is normalised on the
 * way in rather than guarded at each use.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function runAgentTurn(
  deps: AgentRunDeps,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  const { llm, memory, skills, tools, transcript } = deps;

  /*
   * One id for everything this turn produces.
   *
   * The transcript is a flat list of items, and without this there is no way
   * back from a stored tool result to the question that caused it -- which is
   * what a transcript view, and compaction, both need.
   */
  const turnId = randomUUID();

  const [history, availableSkills] = await Promise.all([
    transcript.load(input.agentId),
    skills.list(input.agentId),
  ]);

  const userItem: Extract<TranscriptPayload, { kind: 'user' }> = {
    kind: 'user',
    content: input.message,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  };

  /*
   * Stored before the model is called, not with the rest of the turn.
   *
   * A turn that dies mid-loop has still been asked a question, and the student
   * can see their own message on the screen. Writing it now is what makes the
   * next turn's replay match what they are looking at.
   */
  await transcript.append([{ agentId: input.agentId, turnId, payload: userItem }]);

  const messages: ChatMessage[] = [
    // Static for the whole conversation, so it caches. Anything that changes
    // between turns goes in the user message instead -- see buildTurnContext.
    {
      role: 'system',
      content: buildSystemPrompt(input.purpose, availableSkills, input.about, Boolean(input.vault)),
    },
    ...renderTranscript(history),
    {
      role: 'user',
      content: buildUserMessage(buildTurnContext(input.timezone), renderUserItem(userItem)),
    },
  ];

  const toolContext: ToolContext = {
    userId: input.userId,
    agentId: input.agentId,
    signal: input.signal,
    memory,
    ...(input.google ? { google: input.google } : {}),
    ...(input.transcriber ? { transcriber: input.transcriber } : {}),
    ...(input.youtube ? { youtube: input.youtube } : {}),
    ...(input.youtubeTranscripts ? { youtubeTranscripts: input.youtubeTranscripts } : {}),
    ...(input.residentialFetch ? { residentialFetch: input.residentialFetch } : {}),
    ...(input.portals ? { portals: input.portals } : {}),
    ...(input.vault ? { vault: input.vault } : {}),
  };

  // Empty rather than [] -- some providers reject a zero-length tools array,
  // and until OAuth exists no student has any tools registered.
  const toolDefinitions = tools.ids().length > 0 ? tools.toDefinitions() : undefined;

  const toolsUsed: string[] = [];
  const skillsRead: string[] = [];
  const situation = { hasVault: Boolean(input.vault) };
  let reply = '';

  /*
   * Everything this turn produced, written in one batch at the end.
   *
   * Held rather than appended as it happens so a turn that throws mid-loop
   * leaves the transcript with the student's question and nothing else. A
   * half-written turn -- a tool call with no result under it -- would be
   * replayed as fact on every turn after it, and providers reject a call whose
   * result never arrived.
   */
  const pending: AppendTranscriptInput[] = [];
  let last: ChatResponse | undefined;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    input.onActivity?.({ kind: 'thinking' });
    const response = await llm.chat(
      {
        messages,
        tools: toolDefinitions,
        effort: 'xhigh',
        maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
      },
      { userId: input.userId, agentId: input.agentId, signal: input.signal },
    );

    if (response.toolCalls.length === 0) {
      reply = text(response.content);
      last = response;
      break;
    }

    // Carry the tool calls, not just the text: providers require the original
    // call to be replayed before its result.
    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
      ...(response.payload ? { payload: response.payload } : {}),
    });
    pending.push({
      agentId: input.agentId,
      turnId,
      payload: {
        kind: 'assistant',
        content: text(response.content),
        toolCalls: response.toolCalls,
        ...(response.reasoningSummary ? { reasoningSummary: response.reasoningSummary } : {}),
        usage: {
          inputTokens: response.usage.inputTokens,
          cachedInputTokens: response.usage.cachedInputTokens,
        },
      },
      // Its own reasoning, verbatim, so the next turn continues this train of
      // thought rather than re-deriving it from the text it happened to write.
      ...(response.payload ? { providerPayload: response.payload } : {}),
    });

    for (const call of response.toolCalls) {
      toolsUsed.push(call.name);
      /*
       * Reading a skill is reported as the skill, not as the tool that fetches
       * it. "Reading the browser skill" is something a student can recognise
       * on the line under their question; "skill_load" is not.
       */
      const skill = skillRequested(call, situation);
      if (skill) {
        if (!skillsRead.includes(skill)) skillsRead.push(skill);
        input.onActivity?.({ kind: 'skill', name: skill });
      } else {
        input.onActivity?.({ kind: 'tool', name: call.name });
      }
    }

    /*
     * All of them at once.
     *
     * A model that asks for three tools in one response has decided they do
     * not depend on each other, and running them one after another makes the
     * student wait for the sum of three network calls to get one answer. Every
     * step is reported before any of them runs, so the line under the question
     * still names the work in the order it was asked for.
     */
    const results = await Promise.all(
      response.toolCalls.map((call) => tools.execute(call.name, call.arguments, toolContext)),
    );

    response.toolCalls.forEach((call, index) => {
      // Capped before it is sent or stored: one runaway page must not eat the
      // context window, and it would be replayed on every turn after this one.
      const { text: content, truncated } = truncateToolResult(JSON.stringify(results[index]));
      messages.push({ role: 'tool', toolCallId: call.id, content });
      pending.push({
        agentId: input.agentId,
        turnId,
        payload: {
          kind: 'tool_result',
          toolCallId: call.id,
          toolName: call.name,
          content,
          ...(truncated ? { truncated } : {}),
        },
      });
    });
  }

  // The loop ran out of iterations while still calling tools. Rather than
  // returning nothing, ask once more with tools withheld -- the model has all
  // the results it gathered and is forced to answer from them. A student
  // getting a partial answer beats a student getting silence.
  if (!reply.trim()) {
    const final = await llm.chat(
      { messages, effort: 'xhigh', maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS },
      { userId: input.userId, agentId: input.agentId, signal: input.signal },
    );
    reply = text(final.content);
    last = final;
  }

  /*
   * A turn always says something.
   *
   * Asking again usually produces an answer, and when it does not this is
   * what stands between the student and an empty bubble -- which is the worst
   * possible ending, because the work visibly happened. They watched a
   * browser open a page and were then told nothing whatsoever about it.
   *
   * The tools are named because they are the only honest thing left to say:
   * something was done, the model would not describe it, and the student
   * should be told that rather than left to guess.
   */
  if (!reply.trim()) {
    reply = toolsUsed.length
      ? `I did the work (${[...new Set(toolsUsed)].join(', ')}) but could not put an answer ` +
        'together from it. Ask me again and I will try to say what I found.'
      : 'I could not come up with an answer to that. Try asking me again, or in another way.';
  }

  /*
   * The whole turn, in one write.
   *
   * Last, and once: until this lands the transcript holds the student's
   * question and nothing else, which is the only state a failed turn can
   * safely leave behind. The reply is stored even when it is the fallback
   * string, because the model must see what the student was told.
   */
  pending.push({
    agentId: input.agentId,
    turnId,
    payload: {
      kind: 'assistant',
      content: reply,
      // What the request that produced this reply actually cost, which is what
      // the compaction estimate anchors on rather than re-counting characters.
      ...(last
        ? {
            usage: {
              inputTokens: last.usage.inputTokens,
              cachedInputTokens: last.usage.cachedInputTokens,
            },
          }
        : {}),
    },
    ...(last?.payload ? { providerPayload: last.payload } : {}),
  });
  await transcript.append(pending);

  /*
   * Record the exchange verbatim, beside the transcript rather than instead of
   * it.
   *
   * This is no longer what the model reads -- the transcript is -- but two
   * other things still live off it: the worker's job that writes the student's
   * chats page, and memory_search, which is how a turn reaches what compaction
   * has since summarised away.
   *
   * The instinct to filter here -- only remember "important" turns -- is worth
   * resisting. Curation is what the summarisation job is for, and it can judge
   * significance with the whole period in view, which a single turn cannot.
   * Filtering at write time throws away context before anything has had the
   * chance to decide it mattered, and the loss is silent and unrecoverable.
   */
  await memory.record({
    agentId: input.agentId,
    kind: 'conversation',
    content: `Student: ${input.message}\nAgent: ${reply}`,
    source: 'agent_run',
  });

  return { reply, toolsUsed, skillsRead };
}

/**
 * Assemble the system prompt.
 *
 * Ordering here is deliberate and worth preserving: stable content first
 * (purpose, then skills), volatile content last (memory). Providers cache on a
 * prefix match, so anything that changes per turn invalidates everything after
 * it. Putting recalled memory above the skill list would silently destroy the
 * cache hit rate -- and the cached-token discount is the main thing keeping the
 * platform tier affordable.
 */
/**
 * What every agent is told about sites behind a login, before it has loaded
 * anything.
 *
 * Only the part that has to be universal: the honest default -- "I cannot
 * handle your password" -- is wrong here, and a model that has not yet
 * loaded the browser skill still has to know that. How to actually sign in,
 * refresh and browse is the skill. Exported so a test can hold it to the
 * promises it makes; the failure it prevents is not a crash but an agent
 * politely declining, which reads to a student as the product not working.
 */
export const SIGN_IN_SECTION =
  'Sites that need a login:\n' +
  'Some of what this student needs is behind a sign-in -- a school portal, a course site. ' +
  'They have saved the username and password for those on their own computer, in its ' +
  'keychain. You never see it, are never given it, and must never ask for it. You CAN get ' +
  'at those sites: their computer signs in for you. Never say you cannot handle a password, ' +
  'cannot log in, or that they must sign in by hand -- none of it is true here, and there is ' +
  'no manual sign-in to send them to. Load the browser skill before you open, check, or sign ' +
  'in to any site.';

/**
 * Exported for the eval harness, which needs to assemble the real prompt with
 * and without a given document to measure what that document is worth.
 */
export function buildSystemPrompt(
  purpose: string,
  skills: Awaited<ReturnType<SkillRegistry['list']>>,
  /** The page the vault writes about them. See vault/user-doc.ts. */
  about?: string,
  hasVault = false,
): string {
  /*
   * Tier 1 -- universal. Byte-identical for every agent on the platform.
   *
   * This is the only run of text a provider can serve from cache across
   * different students, so it goes first and nothing that varies is allowed
   * above it. Adding a section here is close to free; adding one below is not.
   */
  const universal = [
    'You are a personal agent built by a student, for themselves. You belong to ' +
      'them, not to their school.',
    /* How to talk to them. Measured at 15% -> 100% clean replies; see src/evals. */
    RESPONDING.body,
    /*
     * How signing in works here, because the honest default is wrong.
     *
     * Asked to log into a site, a model reaches for the safe answer -- "I
     * cannot handle your password" -- which is true of the model and false of
     * this product. The student's sign-in is already saved on their own
     * machine and the agent never sees it; a tool call makes that machine use
     * it. Without saying so, the agent refuses work it can actually do, and
     * the student is told to go and do by hand a thing that was built to be
     * automatic.
     */
    SIGN_IN_SECTION,
    /*
     * What skills exist and when to load one.
     *
     * The bodies are not here. They arrive through skill_load on a turn that
     * needs them, which is what keeps a question about nothing in particular
     * from paying for a page about wikilinks. Universal in the sense that
     * matters -- identical for every student in the same situation -- so it
     * stays in the cached tier; the vault skills are named only when there is
     * a vault, and a student who has connected nothing carries nothing about it.
     */
    skillsSection({ hasVault }),
  ];

  /*
   * Tier 2 -- per agent. Stable for one student across a whole conversation.
   */
  /*
   * Only when they wrote one.
   *
   * A chat started from a message has no purpose behind it, and the line
   * printed anyway -- "Your purpose, in their words:" followed by nothing --
   * is worse than its absence: it tells the model there is supposed to be an
   * answer here and that it is empty, which reads as a student who wants
   * nothing.
   */
  const perAgent = purpose.trim() ? [`Your purpose, in their words: ${purpose}`] : [];

  /*
   * Who this student is, and what else there is to open.
   *
   * The only page carried on a turn. It is short, it names the rest in
   * [[double brackets]], and everything it names -- a class, their school, what
   * they have told us before -- is opened by name when a question turns out to
   * be about one of them. That is what keeps a vault of any size to a fixed
   * cost per turn.
   *
   * It replaced a second document here, the per-agent conversation profile. One
   * page rather than two because the split was wrong rather than merely
   * wasteful: the profile belonged to an agent, so a student with three of them
   * told each separately that they read on a phone. What they say is now kept
   * once, on a page of its own, and named from this one.
   *
   * Per-agent tier rather than volatile: it is rewritten only between
   * conversations, so it stays byte-identical for a whole conversation and
   * keeps its place in the cached prefix.
   */
  if (about && about.trim() !== '') {
    perAgent.push(`What their vault says about them:\n${about.trim()}`);
  }

  if (skills.length > 0) {
    perAgent.push(
      'Skills you have learned:\n' +
        skills.map((s) => `- ${s.name}: ${s.description}\n  ${s.instructions}`).join('\n'),
    );
  }

  return [...universal, ...perAgent].join('\n\n');
}

/**
 * What is true only right now, and is never stored.
 *
 * Everything else the model needs is either in the system prompt or in the
 * transcript. This block is what neither can hold: the clock. It rides in
 * front of the student's message and is thrown away with the turn, because a
 * time replayed a week later is not merely stale, it is wrong -- which is why
 * the stored user item is the student's words alone.
 *
 * It lives apart from buildSystemPrompt for one measured reason. On the
 * Responses API the system prompt is cached as a whole blob keyed on its exact
 * text, not as a prefix: appending six tokens to a 3,613-token prompt took
 * `cached_tokens` from 3,610 to zero. The message list, by contrast, does
 * prefix-match. So a clock that ticks every minute does not merely strand the
 * sections below it -- while it sits in the system prompt, nothing in it
 * caches, ever. See src/evals/cache.ts for the measurement.
 *
 * The block is labelled because it rides along with the student's message and
 * must not be read as something the student typed.
 */
export function buildTurnContext(timezone: string | undefined): string {
  /*
   * Temporal grounding.
   *
   * A model has no clock and no location. Without this it cannot resolve
   * "tomorrow", "this week", or "3pm" into the dates its tools and the
   * student's coursework use -- so it asks the student what timezone they
   * are in, every time, which reads as the agent being broken.
   */
  return currentTimeSection(timezone);
}

/**
 * The student's message, with this turn's context riding in front of it.
 *
 * Exported so the eval harness sends exactly what production sends.
 */
export function buildUserMessage(context: string, message: string): string {
  return `<turn_context>\n${context}\n</turn_context>\n\n${message}`;
}

/**
 * Tell the agent when and where it is.
 *
 * Exported for tests -- an off-by-one here silently schedules everything on
 * the wrong day.
 */
export function currentTimeSection(timezone: string | undefined, now = new Date()): string {
  const zone = timezone || 'UTC';

  let local: string;
  let offset: string;
  try {
    local = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(now);
    // The model needs the numeric offset to build a valid ISO string; a zone
    // name alone is not enough, and the offset changes with daylight saving.
    offset =
      new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longOffset' })
        .formatToParts(now)
        .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  } catch {
    // An invalid timezone string must not take down the turn.
    return `The current time is ${now.toISOString()} (UTC). Assume UTC unless the student says otherwise.`;
  }

  return (
    `Right now it is ${local} for the student. Their timezone is ${zone} (${offset}).\n` +
    'Use this to resolve relative times like "tomorrow" or "next Tuesday", and always ' +
    'include the offset when passing timestamps to tools. Do not ask the student what ' +
    'timezone they are in -- you already know.'
  );
}
