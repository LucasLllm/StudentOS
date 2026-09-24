import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { agentMemories, agentMessages, agents, projects } from '@contexto/db';
import {
  createAgentSchema,
  sendMessageSchema,
  updateChatSchema,
  updateProfileSchema,
  ContextoError,
} from '@contexto/shared';
import type { Agent } from '@contexto/shared';
import type { AppContext } from '../context.js';
import { Vault, buildGraph, forgetChatInChatsDoc, writeUserDoc } from '@contexto/agent';
import { runTurnForAgent, toMessage } from '../agent-turn.js';
import { turnActivity, turnRunning, turnSkills } from '../turns-in-flight.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';

export function createAgentRoutes(ctx: AppContext) {
  const auth = requireAuth(ctx);

  /**
   * Load an agent, or throw if it does not belong to the caller.
   *
   * Every handler goes through this. Scoping the query by userId rather than
   * fetching then comparing means a mistake produces "not found" rather than
   * someone else's agent -- and it is one query either way.
   */
  async function ownedAgent(userId: string, agentId: string) {
    const [row] = await ctx.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .limit(1);

    if (!row) {
      throw new ContextoError('not_found', 'Agent not found.');
    }
    return row;
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      .get('/', auth, async (c) => {
        /*
         * Pinned first, then most recently used.
         *
         * NULLS LAST on the pin, because an unpinned chat has no pin date and
         * Postgres sorts nulls first on DESC by default -- which would put
         * every ordinary chat above every pinned one, the exact inverse.
         *
         * Archived rows come back too. The rail hides them and settings lists
         * them, and one query answering both beats a flag on the request.
         *
         * Chats inside a project do not. They are listed on the project's
         * page, and a rail carrying them too would be every project's chats
         * mixed back into the list projects exist to take them out of.
         */
        const rows = await ctx.db
          .select()
          .from(agents)
          .where(and(eq(agents.userId, c.get('userId')), isNull(agents.projectId)))
          .orderBy(sql`${agents.pinnedAt} desc nulls last`, desc(agents.updatedAt));

        return c.json({ agents: rows.map(toAgent) });
      })

      // zValidator, not a parse() inside the handler: it validates at the route
      // boundary AND lets hono/client infer the request body type, so a schema
      // change is a compile error in the web app rather than a runtime 400.
      .post('/', auth, zValidator('json', createAgentSchema), async (c) => {
        const body = c.req.valid('json');
        /*
         * Only into a project of the caller's own. Without this a chat could be
         * started in somebody else's project and read its context on its first
         * turn -- the one hole a projectId from the request opens.
         */
        if (body.projectId) {
          const [project] = await ctx.db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.id, body.projectId), eq(projects.userId, c.get('userId'))))
            .limit(1);
          if (!project) throw new ContextoError('not_found', 'Project not found.');
          await ctx.db
            .update(projects)
            .set({ updatedAt: new Date() })
            .where(eq(projects.id, project.id));
        }
        const [row] = await ctx.db
          .insert(agents)
          .values({ userId: c.get('userId'), ...body })
          .returning();

        if (!row) throw new ContextoError('internal_error', 'Failed to create agent.');
        return c.json({ agent: toAgent(row) }, 201);
      })

      .get('/:id', auth, async (c) => {
        const row = await ownedAgent(c.get('userId'), c.req.param('id'));
        return c.json({ agent: toAgent(row) });
      })

      /**
       * Rename, pin, archive -- everything that changes a chat without saying
       * anything to it.
       *
       * Only the fields that arrived are written. Sending `{ pinned: true }`
       * must not blank the name, which is what spreading the whole validated
       * body would do the moment a field is absent.
       *
       * updatedAt is deliberately left alone. It orders the rail by when a
       * chat was last USED, and touching it here would send a chat to the top
       * for being renamed -- or, worse, for being archived.
       */
      .patch('/:id', auth, zValidator('json', updateChatSchema), async (c) => {
        const userId = c.get('userId');
        await ownedAgent(userId, c.req.param('id'));
        const body = c.req.valid('json');

        const changes: Partial<typeof agents.$inferInsert> = {};
        if (body.name !== undefined) changes.name = body.name;
        if (body.archived !== undefined) changes.archivedAt = body.archived ? new Date() : null;
        if (body.pinned !== undefined) changes.pinnedAt = body.pinned ? new Date() : null;

        if (Object.keys(changes).length === 0) {
          const row = await ownedAgent(userId, c.req.param('id'));
          return c.json({ agent: toAgent(row) });
        }

        const [row] = await ctx.db
          .update(agents)
          .set(changes)
          .where(and(eq(agents.id, c.req.param('id')), eq(agents.userId, userId)))
          .returning();

        if (!row) throw new ContextoError('internal_error', 'Failed to update the chat.');
        return c.json({ agent: toAgent(row) });
      })

      /*
       * Correcting what the agent thinks it knows.
       *
       * Deliberately a full replace rather than an append: the student is
       * editing a document, not filing a correction, and the writer will
       * rewrite it from here anyway. Clearing it to empty is a first-class
       * outcome -- "forget what you think you know about me" is the whole
       * reason a person needs to see this at all.
       *
       * The watermark moves with it, so the next pass builds on what they
       * wrote rather than re-deriving what they just deleted.
       */
      .patch('/:id/profile', auth, zValidator('json', updateProfileSchema), async (c) => {
        await ownedAgent(c.get('userId'), c.req.param('id'));
        const [row] = await ctx.db
          .update(agents)
          .set({ profile: c.req.valid('json').profile.trim(), profileUpdatedAt: new Date() })
          .where(eq(agents.id, c.req.param('id')))
          .returning();

        if (!row) throw new ContextoError('internal_error', 'Failed to update the profile.');
        return c.json({ agent: toAgent(row) });
      })

      /*
       * What the agent knows, for the person it knows it about.
       *
       * The profile is a paragraph somebody can read in fifteen seconds. The
       * vault is hundreds of notes, and until there is a way to look at it a
       * student is being told to trust a filing cabinet they have never been
       * shown. Grouped rather than listed flat, because "Courses" and
       * "People" are how a person thinks about their own school.
       */
      .get('/:id/vault', auth, async (c) => {
        await ownedAgent(c.get('userId'), c.req.param('id'));
        const vault = vaultFor(ctx.env?.VAULT_ROOT, c.get('userId'));
        if (!vault) return c.json({ groups: [], episodes: 0 });

        const [entities, episodes] = await Promise.all([
          vault.list('entity'),
          vault.list('episode'),
        ]);

        // Grouped by what the importer called them, which is already the
        // vocabulary a student would use: Course, Assignment, Topic, Person.
        const byKind = new Map<string, { name: string; description: string }[]>();
        for (const note of entities) {
          const group = byKind.get(note.description) ?? [];
          group.push({ name: note.name, description: note.body.split('\n')[0] ?? '' });
          byKind.set(note.description, group);
        }

        return c.json({
          groups: [...byKind.entries()].map(([kind, notes]) => ({ kind, notes })),
          episodes: episodes.length,
        });
      })

      /*
       * The whole vault as a shape.
       *
       * Everything a drawing needs and nothing it does not: no note bodies,
       * because a picture of five hundred notes should not cost five hundred
       * note bodies over the wire.
       */
      .get('/:id/vault/graph', auth, async (c) => {
        await ownedAgent(c.get('userId'), c.req.param('id'));
        const vault = vaultFor(ctx.env?.VAULT_ROOT, c.get('userId'));
        if (!vault) return c.json({ nodes: [], edges: [] });
        return c.json(await buildGraph(vault));
      })

      /** One note, and everything that ever pointed at it. */
      .get('/:id/vault/:name', auth, async (c) => {
        await ownedAgent(c.get('userId'), c.req.param('id'));
        const vault = vaultFor(ctx.env?.VAULT_ROOT, c.get('userId'));
        if (!vault) throw new ContextoError('not_found', 'No vault for this agent.');

        const name = c.req.param('name');
        const note = (await vault.read('entity', name)) ?? (await vault.read('episode', name));
        if (!note) throw new ContextoError('not_found', 'No such note.');

        const timeline = await vault.backlinks(name);
        return c.json({
          /*
           * Mapped rather than returned whole.
           *
           * The stored note carries types that belong to the vault, and
           * handing them straight out makes the route's shape depend on the
           * agent package's internals -- which the compiler noticed before
           * anyone else would have. What a reader needs is these fields.
           */
          note: {
            name: note.name,
            kind: note.kind,
            source: note.source,
            description: note.description,
            body: note.body,
            occurred: note.occurred ?? null,
            actor: note.actor ?? null,
            event: (note.event as string | undefined) ?? null,
            sourceUrl: note.sourceUrl ?? null,
          },
          timeline: timeline.map((entry) => ({
            name: entry.name,
            description: entry.description,
            source: entry.source,
            occurred: entry.occurred ?? null,
            actor: entry.actor ?? null,
            event: (entry.event as string | undefined) ?? null,
          })),
        });
      })

      /**
       * Gone, and off the page it taught.
       *
       * Messages, memories and skills cascade -- see the FKs in packages/db.
       * What the cascade cannot reach is chats.md: it is rewritten whole and
       * keeps no record of which chat said what, so the memories are read
       * before the row goes and the page is rewritten without them after the
       * response. After, because that is a model call and a student pressing
       * Delete should not wait on one. A failure there is logged, and the chat
       * is still gone, which is the half they asked for first.
       *
       * This rewrites the page while the student may be mid-conversation
       * elsewhere, which the background job is careful never to do: the page
       * sits in the cached prefix, so that other conversation loses its cache
       * for the rest of its turns. A one-off cost of an action they chose.
       */
      .delete('/:id', auth, async (c) => {
        const userId = c.get('userId');
        const agent = await ownedAgent(userId, c.req.param('id'));

        /*
         * A project chat never taught the student's own pages anything -- its
         * exchanges went to the project's memory -- so there is nothing there
         * to take back out.
         */
        const vault = agent.projectId ? undefined : vaultFor(ctx.env?.VAULT_ROOT, userId);
        const memories = vault
          ? await ctx.db
              .select({ id: agentMemories.id, content: agentMemories.content })
              .from(agentMemories)
              .where(eq(agentMemories.agentId, agent.id))
              .orderBy(asc(agentMemories.occurredAt))
          : [];

        await ctx.db.delete(agents).where(eq(agents.id, agent.id));

        if (vault && memories.length > 0) {
          void forgetChat(ctx, { vault, userId, memories }).catch((error: unknown) => {
            console.error(`Forgetting a deleted chat failed for student ${userId}`, error);
          });
        }
        return c.body(null, 204);
      })

      .get('/:id/messages', auth, async (c) => {
        const agent = await ownedAgent(c.get('userId'), c.req.param('id'));
        const rows = await ctx.db
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.agentId, agent.id))
          .orderBy(asc(agentMessages.createdAt));

        /*
         * Whether something is working on this conversation right now.
         *
         * A turn outlives the request that started it, so a page loaded after
         * the student closed or refreshed has no local memory of asking. The
         * answer arrives minutes later out of nowhere unless the conversation
         * itself can say it is still thinking.
         */
        return c.json({
          messages: rows.map(toMessage),
          pending: turnRunning(agent.id),
          /*
           * And what it is on, when something is. Absent rather than null on
           * a quiet conversation: there is no step, and a shape saying there
           * is one that happens to be empty invites the client to render it.
           */
          activity: turnActivity(agent.id),
          /*
           * And the skills it has read so far. A list, not a step: reading
           * one is over before the next poll, and the rows it puts on screen
           * have to stay there until the reply arrives to carry them.
           */
          skills: turnSkills(agent.id),
        });
      })

      /**
       * Send a message and run a turn.
       *
       * Not streamed. A turn that calls tools can take a while, and the honest
       * first version returns a complete answer rather than a half-wired stream
       * -- the OpenAI adapter's streaming path still cannot reassemble
       * fragmented tool-call deltas. Streaming is the next thing worth doing
       * here, and it is a provider-layer fix, not a route-layer one.
       */
      .post('/:id/messages', auth, zValidator('json', sendMessageSchema), async (c) => {
        const userId = c.get('userId');
        const agent = await ownedAgent(userId, c.req.param('id'));

        /*
         * Deliberately not tied to the request.
         *
         * Passing c.req.raw.signal meant a student who closed the window or
         * reloaded mid-turn killed the work: the user's message is written
         * before the model runs, the reply only after, so aborting left the
         * question saved with no answer and nothing to say one was coming.
         * The turn now finishes and the reply is stored, and they find it when
         * they come back.
         *
         * Shared with the messaging gateway -- see src/agent-turn.ts.
         */
        const body = c.req.valid('json');
        const result = await runTurnForAgent(ctx, {
          userId,
          agent,
          content: body.content,
          ...(body.attachments ? { attachments: body.attachments } : {}),
        });

        return c.json(result);
      })
  );
}

/** The student's vault, when this deployment has vaults configured. */
function vaultFor(root: string | undefined, ownerId: string): Vault | undefined {
  return root ? new Vault(root, ownerId) : undefined;
}

/**
 * Everything a deleted chat left in the vault, taken out.
 *
 * Its episodes first: a conversation worth keeping was written in as one,
 * carrying the id of the memory it was written from, and that id is the only
 * link back to the chat. No model needed, so it happens before the part that
 * needs one and cannot be lost to it.
 *
 * Then the chats page without it, and the page written from that one.
 */
async function forgetChat(
  ctx: AppContext,
  {
    vault,
    userId,
    memories,
  }: { vault: Vault; userId: string; memories: { id: string; content: string }[] },
): Promise<void> {
  const ids = new Set(memories.map((memory) => memory.id));
  for (const note of await vault.list('episode')) {
    if (note.externalId && ids.has(note.externalId)) await vault.remove('episode', note.name);
  }

  const exchanges = memories.map((memory) => memory.content);
  const llm = await ctx.llm.resolve(userId);
  const { changed } = await forgetChatInChatsDoc({ llm }, { vault, exchanges, userId });
  // The user page describes this one, so it moves when this one does -- the
  // same rule the background job follows.
  if (changed) await writeUserDoc({ llm }, { vault, userId });
}

function toAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    profile: row.profile,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    projectId: row.projectId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
