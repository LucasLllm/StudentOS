import { desc, eq, sql } from 'drizzle-orm';
import { agentMessages, agents, user } from '@contexto/db';
import type { Message, MessageAttachment } from '@contexto/shared';
import { ContextoError } from '@contexto/shared';
import {
  Vault,
  buildToolRegistry,
  nameConversation,
  listDocuments,
  readUserDoc,
  runAgentTurn,
} from '@contexto/agent';
import type { AppContext } from './context.js';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from './google/connections.js';
import { DbPortalSnapshots } from './portal-snapshots.js';
import { beginTurn, endTurn, setActivity } from './turns-in-flight.js';

/**
 * Run one agent turn and persist both sides of it.
 *
 * Shared by the web route and the messaging gateway so a Telegram turn and a
 * browser turn are genuinely the same operation -- same tools, same quota, same
 * transcript. If these ever diverge you have two agents wearing one name, which
 * is exactly what the product promises not to be.
 */
/**
 * The student's vault, if this deployment has vaults and they have one.
 *
 * Entities OR pages. Notes are the usual reason a vault is worth handing to a
 * turn, but they are not the only one: what a student has told us across their
 * conversations is kept as a page in here now, and it is written for anyone who
 * talks to their agent whether or not they have ever connected a school.
 *
 * Gating on notes alone regressed exactly that. The document it replaced was a
 * column on the agent row and was read on every turn regardless; this one sat
 * on disk being written and never read for anybody with nothing imported.
 */
export async function vaultFor(
  root: string | undefined,
  ownerId: string,
): Promise<Vault | undefined> {
  if (!root) return undefined;
  const vault = new Vault(root, ownerId);
  if (await vault.has()) return vault;
  return (await listDocuments(vault)).length > 0 ? vault : undefined;
}

export async function runTurnForAgent(
  ctx: AppContext,
  params: {
    userId: string;
    agent: typeof agents.$inferSelect;
    content: string;
    /** Files that went with this message. */
    attachments?: MessageAttachment[];
    signal?: AbortSignal;
  },
): Promise<{ userMessage: Message; assistantMessage: Message; agentName?: string }> {
  const { userId, agent, content, attachments, signal } = params;

  /*
   * Whether this is the conversation's first word.
   *
   * Counted before the insert below, so "none yet" means what it says. It
   * decides one thing: whether to name the chat, which happens once and never
   * again -- a title that changed as a conversation wandered would stop being
   * a way to find it.
   */
  const [existing] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentMessages)
    .where(eq(agentMessages.agentId, agent.id));
  const opening = (existing?.count ?? 0) === 0;

  const [userMessage] = await ctx.db
    .insert(agentMessages)
    .values({ agentId: agent.id, role: 'user', content, attachments: attachments ?? [] })
    .returning();

  /*
   * From here until the reply is written, this conversation is busy.
   *
   * The question is already saved and the answer does not exist yet, which is
   * exactly the window in which a page loaded from scratch can tell neither
   * that it is coming nor that it was dropped. Marked after the insert so the
   * two are true together: there is a question outstanding, and something is
   * working on it.
   */
  beginTurn(agent.id);
  try {
    // Assembled per turn from what this student has actually connected.
    const [grant, [profile], vault] = await Promise.all([
      getGoogleGrant(ctx.db, userId),
      ctx.db.select({ timezone: user.timezone }).from(user).where(eq(user.id, userId)).limit(1),
      /*
       * Only handed over when there is something in it.
       *
       * Its presence decides whether vault_search can find anything and
       * whether the vault skills are named on the prompt, so an agent whose
       * student has imported nothing carries neither -- and behaves exactly as
       * it did before vaults existed.
       */
      // Optional chaining, not laziness: this is the path a student is waiting
      // on, and a context assembled without env should degrade to no vault
      // rather than take the whole turn down.
      vaultFor(ctx.env?.VAULT_ROOT, userId),
    ]);

    /*
     * The title is written beside the reply, not after it.
     *
     * Naming the chat is its own model call, and doing it once the answer is
     * ready would put its whole duration between the student and their first
     * reply. Run together, it costs nothing measurable: the turn is many
     * times longer, and this finishes inside it.
     */
    const [result, named] = await Promise.all([
      runAgentTurn(
        {
          llm: ctx.llm,
          memory: ctx.memory,
          skills: ctx.skills,
          tools: buildToolRegistry(grant.scope, grant.disabled),
          transcript: ctx.transcript,
        },
        {
          userId,
          agentId: agent.id,
          purpose: agent.purpose,
          // What the summarisation job has learned about them, if anything yet.
          /*
           * Their school, in a paragraph, written when the vault was last built.
           *
           * Read from disk on every turn rather than cached in memory: it
           * changes only when a vault is rebuilt, a read is one small file, and
           * a stale copy in a long-lived process would describe last term.
           */
          ...(vault ? { about: (await readUserDoc(vault)) ?? undefined } : {}),
          ...(vault ? { vault } : {}),
          message: content,
          /*
           * Read now, not searched for later.
           *
           * The note was written moments ago by the upload the message came
           * with, so this is a read of a file already on disk -- and it is what
           * puts a photograph's transcription in front of the model on the turn
           * that asked about it.
           */
          /*
           * Everything attached to this conversation, not just to this message.
           *
           * A photograph is attached once and asked about for the rest of the
           * afternoon. Carrying only the current message's files meant the
           * second question about a worksheet met an agent that had never seen
           * it -- the transcription was in the vault, and out of reach again.
           */
          ...(vault
            ? {
                attachments: await conversationAttachments(ctx, vault, agent.id, attachments ?? []),
              }
            : {}),
          ...(profile?.timezone ? { timezone: profile.timezone } : {}),
          google: new BetterAuthGoogleTokenProvider(ctx.auth, userId, grant.groups, grant.scope),
          ...(ctx.transcriber ? { transcriber: ctx.transcriber } : {}),
          youtube: ctx.youtube,
          youtubeTranscripts: ctx.youtubeTranscripts,
          ...(ctx.residential ? { residentialFetch: ctx.residential.fetch } : {}),
          portals: new DbPortalSnapshots(ctx.db),
          /*
           * Every step the turn takes, handed to the registry the poll reads.
           * This is the whole of what makes the line under a question say what
           * the agent is doing rather than only that it is doing something.
           */
          onActivity: (activity) => setActivity(agent.id, activity),
          ...(signal ? { signal } : {}),
        },
      ),
      opening ? nameTheChat(ctx, agent.id, userId, content) : Promise.resolve(undefined),
    ]);

    const [assistantMessage] = await ctx.db
      .insert(agentMessages)
      .values({
        agentId: agent.id,
        role: 'assistant',
        content: result.reply,
        toolsUsed: result.toolsUsed,
        skillsRead: result.skillsRead,
      })
      .returning();

    // Surfaces the agent in the "recently used" ordering on the list screen.
    await ctx.db.update(agents).set({ updatedAt: new Date() }).where(eq(agents.id, agent.id));

    if (!userMessage || !assistantMessage) {
      throw new ContextoError('internal_error', 'Failed to save messages.');
    }

    return {
      userMessage: toMessage(userMessage),
      assistantMessage: toMessage(assistantMessage),
      ...(named ? { agentName: named } : {}),
    };
  } finally {
    // In a finally: a turn that throws has stopped just as surely as one that
    // succeeded, and leaving it marked busy would spin a thinking indicator
    // for a conversation nothing is working on.
    endTurn(agent.id);
  }
}

export function toMessage(row: typeof agentMessages.$inferSelect): Message {
  return {
    id: row.id,
    agentId: row.agentId,
    role: row.role as Message['role'],
    content: row.content,
    attachments: row.attachments ?? [],
    toolsUsed: row.toolsUsed,
    skillsRead: row.skillsRead,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * How far back to look for files, and how many to carry.
 *
 * Both bounds exist for the same reason: every file carried is its whole text
 * on every turn for the rest of the conversation. A student who attaches a
 * syllabus, a mark sheet and six photographs should not be paying for all
 * nine on their twentieth question -- so the most recent few win, and the
 * older ones go back to being findable in the vault rather than carried.
 */
const ATTACHMENT_LOOKBACK = 40;
const ATTACHMENT_LIMIT = 6;

/**
 * The files this conversation has been given, newest first.
 *
 * The incoming message's own attachments lead, because they are what the
 * question is most likely about; the rest of the conversation follows.
 */
async function conversationAttachments(
  ctx: AppContext,
  vault: Vault,
  agentId: string,
  incoming: MessageAttachment[],
): Promise<{ name: string; body: string }[]> {
  const rows = await ctx.db
    .select({ attachments: agentMessages.attachments })
    .from(agentMessages)
    .where(eq(agentMessages.agentId, agentId))
    .orderBy(desc(agentMessages.createdAt))
    .limit(ATTACHMENT_LOOKBACK);

  const names: string[] = [];
  for (const file of [...incoming, ...rows.flatMap((row) => row.attachments ?? [])]) {
    // Deduped by name: a file re-attached to a later message is one file.
    if (!names.includes(file.name)) names.push(file.name);
    if (names.length >= ATTACHMENT_LIMIT) break;
  }

  return readAttachments(vault, names);
}

/**
 * The notes, as text.
 *
 * A name that is not there is skipped rather than thrown: the upload that
 * wrote it has already reported its own failures, and losing the whole turn
 * because one attachment went missing would be the wrong trade.
 */
async function readAttachments(
  vault: Vault,
  names: string[],
): Promise<{ name: string; body: string }[]> {
  const found = await Promise.all(names.map((name) => vault.read('entity', name)));
  return found
    .filter((note): note is NonNullable<typeof note> => note !== null)
    .map((note) => ({ name: note.name, body: note.body }));
}

/**
 * Give the conversation a name, once.
 *
 * Returns what it settled on so the caller can hand it back and the rail can
 * change without asking again. Null when the model would not produce one, in
 * which case the provisional title -- the opening message, trimmed -- stays,
 * which is what it is for.
 */
async function nameTheChat(
  ctx: AppContext,
  agentId: string,
  userId: string,
  question: string,
): Promise<string | undefined> {
  /*
   * The registry, not a resolved provider. Its own chat resolves per student
   * and bills them, which is what a turn already does -- so a title is
   * metered against the same key and quota as the conversation it names.
   */
  const title = await nameConversation({ llm: ctx.llm }, { question, userId });
  if (!title) return undefined;

  /*
   * updatedAt is left alone deliberately: the rail is ordered by when a chat
   * was last used, and naming one is not using it. Touching it here would
   * have every new chat jump the queue a second time for being named.
   */
  await ctx.db.update(agents).set({ name: title }).where(eq(agents.id, agentId));
  return title;
}
