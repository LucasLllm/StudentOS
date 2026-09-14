import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { agentMessages, agents, user } from '@contexto/db';
import type { Message, MessageAttachment } from '@contexto/shared';
import { ContextoError } from '@contexto/shared';
import {
  Vault,
  bootstrapItems,
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

  /*
   * Chats that were had before the transcript table existed start from what
   * they do have.
   *
   * Their words are in agent_messages and nowhere else, so the first turn
   * after the upgrade seeds the transcript from them rather than meeting a
   * student it has been talking to all week as a stranger. Only the words:
   * the tool results and the reasoning that produced them were never stored
   * and are not coming back. Once, too -- the count is zero exactly until
   * this has run, and it is read before the question below is inserted so
   * the seed holds the conversation as it was, without today's message in it
   * twice.
   *
   * Two first turns arriving at once on a legacy chat can both seed: the
   * turns-in-flight count is a counter, not a lock, so both read zero. The
   * effect is the seeded words replayed twice, not a crash; a per-chat lock is
   * the fix if it is ever observed.
   */
  if (!opening && (await ctx.transcript.count(agent.id)) === 0) {
    const rows = await ctx.db
      .select({ role: agentMessages.role, content: agentMessages.content })
      .from(agentMessages)
      .where(eq(agentMessages.agentId, agent.id))
      .orderBy(asc(agentMessages.createdAt));
    await ctx.transcript.append(
      bootstrapItems(rows).map((payload) => ({ agentId: agent.id, turnId: randomUUID(), payload })),
    );
  }

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
          plans: ctx.plans,
        },
        {
          userId,
          agentId: agent.id,
          purpose: agent.purpose,
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
           * This message's files, read now rather than searched for later.
           *
           * The note was written moments ago by the upload the message came
           * with, so this is a read of a file already on disk -- and it is what
           * puts a photograph's transcription in front of the model on the turn
           * that asked about it. Only this message's: the transcript carries
           * every earlier file, in the question it arrived with, so a
           * photograph asked about all afternoon is read once and replayed
           * rather than re-read onto every question after it.
           */
          ...(vault
            ? {
                attachments: await readAttachments(
                  vault,
                  (attachments ?? []).map((a) => a.name),
                ),
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
