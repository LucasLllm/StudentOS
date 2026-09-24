import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, sql } from 'drizzle-orm';
import { agents, projectSources, projects } from '@contexto/db';
import { UPLOAD_LIMIT_BYTES, imagePath, projectVault, removeProjectVault } from '@contexto/agent';
import {
  ContextoError,
  createProjectSchema,
  driveSourceSchema,
  textSourceSchema,
  updateProjectSchema,
  type Project,
  type ProjectChat,
  type ProjectSource,
} from '@contexto/shared';
import type { AppContext } from '../context.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { startGathering } from '../projects/gather.js';
import {
  addDriveFile,
  addText,
  addUpload,
  noteOf,
  ownedProject,
  touchProject,
  vaultRootOf,
} from '../projects/sources.js';
import { UPLOAD_REFUSALS } from './uploads.js';

/**
 * Projects, their chats, and their context.
 *
 * Every handler goes through ownedProject, which scopes by the caller in the
 * query itself: a mistake is "not found", never another student's project.
 */
export function createProjectRoutes(ctx: AppContext) {
  const auth = requireAuth(ctx);

  /** The model that summarises a context item, metered like any turn. */
  const summariser = ctx.llm;

  return (
    new Hono<{ Variables: AuthVariables }>()
      .get('/', auth, async (c) => {
        const rows = await ctx.db
          .select()
          .from(projects)
          .where(eq(projects.userId, c.get('userId')))
          .orderBy(desc(projects.updatedAt));
        return c.json({ projects: rows.map(toProject) });
      })

      .post('/', auth, zValidator('json', createProjectSchema), async (c) => {
        const userId = c.get('userId');
        const body = c.req.valid('json');
        const [row] = await ctx.db
          .insert(projects)
          .values({ userId, name: body.name, instructions: body.instructions.trim() })
          .returning();
        if (!row) throw new ContextoError('internal_error', 'Failed to create the project.');

        /*
         * Not awaited. The student is taken to the project page at once and
         * watches its context arrive; the sweep marks itself finished whether
         * it found anything or failed.
         */
        startGathering(ctx, { userId, projectId: row.id });
        return c.json({ project: toProject(row) }, 201);
      })

      .get('/:id', auth, async (c) => {
        const row = await ownedProject(ctx, c.get('userId'), c.req.param('id'));
        return c.json({ project: toProject(row) });
      })

      /*
       * Renaming and changing the goal. Chats already open keep the goal they
       * were started with -- their block is frozen -- and the next chat has the
       * new one, which is the same rule the rest of the block follows.
       */
      .patch('/:id', auth, zValidator('json', updateProjectSchema), async (c) => {
        const userId = c.get('userId');
        await ownedProject(ctx, userId, c.req.param('id'));
        const body = c.req.valid('json');
        const changes: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
        if (body.name !== undefined) changes.name = body.name;
        if (body.instructions !== undefined) changes.instructions = body.instructions.trim();

        const [row] = await ctx.db
          .update(projects)
          .set(changes)
          .where(and(eq(projects.id, c.req.param('id')), eq(projects.userId, userId)))
          .returning();
        if (!row) throw new ContextoError('internal_error', 'Failed to update the project.');
        return c.json({ project: toProject(row) });
      })

      /*
       * The project, its chats and everything brought into it. Notes it only
       * linked from the student's vault stay where they were: they were never
       * the project's to delete.
       */
      .delete('/:id', auth, async (c) => {
        const userId = c.get('userId');
        const project = await ownedProject(ctx, userId, c.req.param('id'));
        await ctx.db.delete(projects).where(eq(projects.id, project.id));
        if (ctx.env?.VAULT_ROOT) await removeProjectVault(ctx.env.VAULT_ROOT, userId, project.id);
        return c.body(null, 204);
      })

      .get('/:id/chats', auth, async (c) => {
        const project = await ownedProject(ctx, c.get('userId'), c.req.param('id'));
        /*
         * The last thing said in each, in the same query. A chat list of a
         * few dozen rows is one round trip rather than one per row.
         */
        const rows = await ctx.db
          .select({
            id: agents.id,
            name: agents.name,
            updatedAt: agents.updatedAt,
            preview: sql<string | null>`(
              select m.content from agent_messages m
              where m.agent_id = ${agents.id}
              order by m.created_at desc limit 1
            )`,
          })
          .from(agents)
          .where(and(eq(agents.projectId, project.id), eq(agents.userId, c.get('userId'))))
          .orderBy(desc(agents.updatedAt));

        const chats: ProjectChat[] = rows.map((row) => ({
          id: row.id,
          name: row.name,
          preview: oneLine(row.preview ?? '', 140),
          updatedAt: row.updatedAt.toISOString(),
        }));
        return c.json({ chats });
      })

      .get('/:id/sources', auth, async (c) => {
        const userId = c.get('userId');
        const project = await ownedProject(ctx, userId, c.req.param('id'));
        const root = vaultRootOf(ctx);
        const rows = await ctx.db
          .select()
          .from(projectSources)
          .where(eq(projectSources.projectId, project.id))
          .orderBy(desc(projectSources.addedAt));

        const sources: ProjectSource[] = [];
        for (const row of rows) {
          const note = await noteOf(root, userId, row);
          sources.push(toSource(row, note?.body ?? ''));
        }
        return c.json({ sources });
      })

      /** One item in full, for the viewer. */
      .get('/:id/sources/:sourceId', auth, async (c) => {
        const userId = c.get('userId');
        const project = await ownedProject(ctx, userId, c.req.param('id'));
        const row = await ownedSource(project.id, c.req.param('sourceId'));
        const note = await noteOf(vaultRootOf(ctx), userId, row);
        return c.json({ source: toSource(row, note?.body ?? ''), body: note?.body ?? '' });
      })

      /*
       * Out of the context. A note the project owned goes with it; a linked
       * one is only unlinked.
       */
      .delete('/:id/sources/:sourceId', auth, async (c) => {
        const userId = c.get('userId');
        const project = await ownedProject(ctx, userId, c.req.param('id'));
        const row = await ownedSource(project.id, c.req.param('sourceId'));
        await ctx.db.delete(projectSources).where(eq(projectSources.id, row.id));
        if (row.owned) {
          await projectVault(vaultRootOf(ctx), userId, project.id).remove(
            row.noteKind,
            row.noteName,
          );
        }
        await touchProject(ctx, project.id);
        return c.body(null, 204);
      })

      /*
       * A file, into the project. Answers in the shape /uploads does, so the
       * chat composer can attach through it inside a project, and with the
       * context item it became.
       */
      .post('/:id/sources/upload', auth, async (c) => {
        const userId = c.get('userId');
        const project = await ownedProject(ctx, userId, c.req.param('id'));
        const body = await c.req.parseBody();
        const file = body['file'];
        const context = typeof body['context'] === 'string' ? body['context'] : undefined;
        if (!(file instanceof File)) {
          throw new ContextoError('validation_failed', 'No file was attached.');
        }
        if (file.size > UPLOAD_LIMIT_BYTES) {
          throw new ContextoError('validation_failed', UPLOAD_REFUSALS['too-large']);
        }

        const { result, row } = await addUpload(ctx, await ctx.llm.resolve(userId), {
          userId,
          projectId: project.id,
          file,
          ...(context ? { context } : {}),
        });
        if (!result.ok) {
          throw new ContextoError('validation_failed', UPLOAD_REFUSALS[result.reason]);
        }
        return c.json({
          name: result.name,
          filename: file.name,
          image: result.image,
          ...(row ? { source: toSource(row, '') } : {}),
        });
      })

      .post('/:id/sources/text', auth, zValidator('json', textSourceSchema), async (c) => {
        const userId = c.get('userId');
        const project = await ownedProject(ctx, userId, c.req.param('id'));
        const { title, body } = c.req.valid('json');
        const row = await addText(ctx, summariser, { userId, projectId: project.id, title, body });
        if (!row) throw new ContextoError('internal_error', 'That could not be added.');
        return c.json({ source: toSource(row, body) }, 201);
      })

      /*
       * Files the student picked in Drive. Read one at a time -- Drive rate
       * limits a burst, and ten is the most the picker hands over here.
       */
      .post('/:id/sources/drive', auth, zValidator('json', driveSourceSchema), async (c) => {
        const userId = c.get('userId');
        const project = await ownedProject(ctx, userId, c.req.param('id'));
        const added: string[] = [];
        const failed: { fileId: string; reason: string }[] = [];
        for (const fileId of c.req.valid('json').fileIds) {
          // Each on its own: one file Drive chokes on must not lose the other nine.
          const result = await addDriveFile(ctx, summariser, {
            userId,
            projectId: project.id,
            fileId,
          }).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : 'Drive would not open that file.',
          }));
          if ('error' in result) failed.push({ fileId, reason: result.error });
          else added.push(result.name);
        }
        return c.json({ added, failed });
      })

      /** A picture brought into the project, served back for its card. */
      .get('/:id/images/:name', auth, async (c) => {
        const userId = c.get('userId');
        const project = await ownedProject(ctx, userId, c.req.param('id'));
        const name = c.req.param('name');
        if (!/^[a-z0-9-]{1,120}$/.test(name)) {
          throw new ContextoError('validation_failed', 'Not a file name.');
        }
        const vault = projectVault(vaultRootOf(ctx), userId, project.id);
        for (const extension of ['png', 'jpg', 'gif', 'webp']) {
          try {
            const bytes = await readFile(imagePath(vault, name, extension));
            return c.body(bytes.buffer as ArrayBuffer, 200, {
              'content-type': extension === 'jpg' ? 'image/jpeg' : `image/${extension}`,
              'cache-control': 'private, max-age=31536000, immutable',
            });
          } catch {
            // Not this extension.
          }
        }
        throw new ContextoError('not_found', 'No such picture.');
      })
  );

  async function ownedSource(projectId: string, sourceId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new ContextoError('not_found', 'Not found.');
    const [row] = await ctx.db
      .select()
      .from(projectSources)
      .where(and(eq(projectSources.id, sourceId), eq(projectSources.projectId, projectId)))
      .limit(1);
    if (!row) throw new ContextoError('not_found', 'Not found.');
    return row;
  }
}

/** Longer than any sweep takes: two small calls and a handful of reads. */
const GATHER_GIVE_UP_MS = 10 * 60_000;

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    /*
     * A sweep lives in the process that started it. One cut short by a
     * restart never marks itself done, so past a few minutes it is taken as
     * finished rather than left saying "Looking through your files" for ever.
     */
    gathering: row.gatheredAt === null && Date.now() - row.createdAt.getTime() < GATHER_GIVE_UP_MS,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The "What is in it" heading an upload's note opens with is the vault's, not the student's. */
function previewOf(body: string): string {
  return oneLine(body.replace(/^## What is in it\s*/, ''), 400);
}

function toSource(row: typeof projectSources.$inferSelect, body: string): ProjectSource {
  return {
    id: row.id,
    name: row.noteName,
    kind: row.kind,
    summary: row.summary,
    preview: previewOf(body),
    image: row.image,
    addedAt: row.addedAt.toISOString(),
  };
}
