import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { user } from '@contexto/db';
import {
  addCredentialSchema,
  updateProfileSettingsSchema,
  ContextoError,
  type MeProfile,
  type UsageStatus,
} from '@contexto/shared';
import { readFile } from 'node:fs/promises';
import { UPLOAD_LIMIT_BYTES, Vault, imagePath, importUpload } from '@contexto/agent';
import type { UploadRefusal } from '@contexto/agent';
import { currentWindowEnd, currentWindowStart } from '@contexto/llm';
import type { AppContext } from '../context.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { createAgentRoutes } from './agents.js';
import { createChannelRoutes } from './channels.js';
import { createDeviceRoutes } from './devices.js';
import { createGoogleRoutes } from './google.js';
import { createHookRoutes } from './hooks.js';
import { createVaultRoutes } from './vault.js';

/**
 * Application routes.
 *
 * The return type is exported so the web app can build a fully typed client
 * with hono/client -- no hand-maintained API types, no codegen step.
 */
export function createRoutes(ctx: AppContext) {
  const auth = requireAuth(ctx);

  return (
    new Hono<{ Variables: AuthVariables }>()
      .get('/health', (c) => c.json({ ok: true }))

      /**
       * Whether the optional pieces are actually working.
       *
       * Separate from /health, which must stay a cheap liveness probe for the
       * deploy script. This one reaches out, so it is for a human asking why
       * something got worse -- most often a residential relay on a machine at
       * home that has been rebooted or unplugged.
       */
      .get('/health/egress', auth, async (c) => {
        const residential = ctx.residential ? await ctx.residential.healthy() : null;
        return c.json({
          residential,
          note:
            residential === null
              ? 'No residential egress configured. Sites that block datacenters will fail.'
              : residential
                ? 'Residential egress reachable.'
                : 'Residential egress configured but NOT reachable -- is the machine on?',
        });
      })

      /**
       * Record the student's timezone.
       *
       * Sent by the browser, which is the only thing that reliably knows it.
       * Validated against the runtime's own timezone database rather than a
       * regex -- a bogus zone would otherwise be stored and then throw on
       * every turn when the prompt tries to format a time in it.
       */
      .put(
        '/me/timezone',
        auth,
        zValidator('json', z.object({ timezone: z.string().min(1).max(64) })),
        async (c) => {
          const { timezone } = c.req.valid('json');

          try {
            new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
          } catch {
            throw new ContextoError('validation_failed', 'Unknown timezone.');
          }

          await ctx.db
            .update(user)
            .set({ timezone })
            .where(eq(user.id, c.get('userId')));

          return c.body(null, 204);
        },
      )

      /**
       * A file from the student's own machine.
       *
       * It lands in the vault rather than on a message, so it outlives the
       * conversation it was attached to and every later chat can read it. The
       * turn needs no plumbing for it: the message names what was attached and
       * the agent opens it by name, exactly as it opens anything else there.
       *
       * Nothing is stored but the text. The bytes are read, extracted from and
       * dropped -- there is no file store to secure, back up or bill for, and
       * the thing worth keeping was never the PDF.
       */
      .post('/uploads', auth, async (c) => {
        if (!ctx.env?.VAULT_ROOT) {
          throw new ContextoError(
            'validation_failed',
            'This deployment has no vault to upload into.',
          );
        }

        const body = await c.req.parseBody();
        const file = body['file'];
        // What the student was typing when they attached it. Steers how a
        // picture is read; ignored for everything else.
        const context = typeof body['context'] === 'string' ? body['context'] : undefined;
        if (!(file instanceof File)) {
          throw new ContextoError('validation_failed', 'No file was attached.');
        }

        /*
         * Checked before the body is read into memory as well as inside
         * importUpload. The inner check is the one that is correct; this one
         * is the one that is cheap.
         */
        if (file.size > UPLOAD_LIMIT_BYTES) {
          throw new ContextoError('validation_failed', REFUSALS['too-large']);
        }

        const userId = c.get('userId');
        const vault = new Vault(ctx.env.VAULT_ROOT, userId);

        /*
         * A model, for the pictures.
         *
         * Resolved per student so the reading is billed to whoever's key or
         * quota it belongs to, exactly as a turn is. Only images need it, and
         * importUpload refuses them clearly when it is absent rather than
         * failing somewhere further down.
         */
        const result = await importUpload(
          vault,
          {
            filename: file.name,
            mimeType: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
          },
          { llm: await ctx.llm.resolve(userId), userId, ...(context ? { context } : {}) },
        );

        if (!result.ok) throw new ContextoError('validation_failed', REFUSALS[result.reason]);
        return c.json({ name: result.name, filename: file.name, image: result.image });
      })

      /**
       * A picture the student uploaded, served back to them.
       *
       * Only pictures are kept, and only so a conversation can show one above
       * the question it was attached to. The name comes from the URL and is
       * checked against the slug alphabet before it is joined onto a path --
       * Vault does the same check on the way in, and this is the way out.
       */
      .get('/uploads/:name', auth, async (c) => {
        if (!ctx.env?.VAULT_ROOT) throw new ContextoError('not_found', 'No vault here.');

        const name = c.req.param('name');
        if (!/^[a-z0-9-]{1,120}$/.test(name)) {
          throw new ContextoError('validation_failed', 'Not a file name.');
        }

        const vault = new Vault(ctx.env.VAULT_ROOT, c.get('userId'));
        for (const extension of ['png', 'jpg', 'gif', 'webp']) {
          try {
            const bytes = await readFile(imagePath(vault, name, extension));
            return c.body(bytes.buffer as ArrayBuffer, 200, {
              'content-type': extension === 'jpg' ? 'image/jpeg' : `image/${extension}`,
              // Immutable: the name is derived from the file, so a different
              // picture is a different name.
              'cache-control': 'private, max-age=31536000, immutable',
            });
          } catch {
            // Not this extension. The list is short and a miss costs a stat.
          }
        }

        throw new ContextoError('not_found', 'No such picture.');
      })

      /** Who the student is, and what they have chosen to be called. */
      .get('/me', auth, async (c) => {
        const [row] = await ctx.db
          .select({
            name: user.name,
            email: user.email,
            preferredName: user.preferredName,
            appearance: user.appearance,
            image: user.image,
          })
          .from(user)
          .where(eq(user.id, c.get('userId')))
          .limit(1);

        if (!row) throw new ContextoError('not_found', 'No such account.');

        return c.json({
          name: row.name,
          email: row.email,
          // Falls back to the first name, which is what almost everyone wants
          // and nobody should have to type.
          preferredName: row.preferredName?.trim() || row.name.trim().split(/\s+/)[0] || '',
          appearance: (row.appearance ?? 'system') as 'light' | 'dark' | 'system',
          hasAvatar: Boolean(row.image),
        } satisfies MeProfile);
      })

      .patch('/me', auth, zValidator('json', updateProfileSettingsSchema), async (c) => {
        const body = c.req.valid('json');
        const changes: { preferredName?: string | null; appearance?: string | null } = {};

        /*
         * An empty name is a clearing, not a blank.
         *
         * "Go back to calling me what my account says" is a thing a student
         * will want, and the way they will ask for it is by emptying the box.
         */
        if (body.preferredName !== undefined) {
          changes.preferredName = body.preferredName.trim() || null;
        }
        if (body.appearance !== undefined) {
          changes.appearance = body.appearance === 'system' ? null : body.appearance;
        }

        if (Object.keys(changes).length > 0) {
          await ctx.db
            .update(user)
            .set(changes)
            .where(eq(user.id, c.get('userId')));
        }
        return c.body(null, 204);
      })

      .route('/agents', createAgentRoutes(ctx))
      .route('/google', createGoogleRoutes(ctx))
      .route('/vault', createVaultRoutes(ctx))
      .route('/channels', createChannelRoutes(ctx))
      .route('/devices', createDeviceRoutes(ctx))
      .route('/hooks', createHookRoutes(ctx))

      /** Which BYOK keys this student has stored. Never includes key material. */
      .get('/credentials', auth, async (c) => {
        const credentials = await ctx.vault.list(c.get('userId'));
        return c.json({ credentials });
      })

      .post('/credentials', auth, zValidator('json', addCredentialSchema), async (c) => {
        const credential = await ctx.vault.add({
          userId: c.get('userId'),
          ...c.req.valid('json'),
        });
        return c.json({ credential }, 201);
      })

      .delete('/credentials/:id', auth, async (c) => {
        await ctx.vault.remove(c.get('userId'), c.req.param('id'));
        return c.body(null, 204);
      })

      /**
       * Where the student currently stands: own key or our tier, and how much of
       * their allowance is left. Drives the "you're running low" nudge toward
       * adding their own key.
       */
      .get('/usage', auth, async (c) => {
        const userId = c.get('userId');
        const credentials = await ctx.vault.list(userId);

        if (credentials.length > 0) {
          const status: UsageStatus = {
            activeProvider: credentials[0]!.provider,
            quota: null,
            limits: null,
          };
          return c.json(status);
        }

        /*
         * An exempt account reports no quota, the same shape as a student on
         * their own key. Showing "5,120,000 / 5,000,000 used" to someone the
         * limit does not apply to would read as a problem to fix.
         */
        if (await ctx.quota.isExempt(userId)) {
          return c.json({
            activeProvider: 'platform',
            quota: null,
            limits: null,
          } satisfies UsageStatus);
        }

        const status: UsageStatus = {
          activeProvider: 'platform',
          quota: {
            windowStart: currentWindowStart().toISOString(),
            windowEnd: currentWindowEnd().toISOString(),
            tokensUsed: await ctx.quota.tokensUsedThisWindow(userId),
            tokenLimit: ctx.quota.limit,
          },
          limits: await ctx.quota.standing(userId),
        };
        return c.json(status);
      })
  );
}

export type AppRoutes = ReturnType<typeof createRoutes>;

/**
 * Why a file was turned away, in words a student can act on.
 *
 * Kept beside the route rather than in the vault module: what the extractor
 * reports is a fact about the file, and what to say about it is a fact about
 * this product. "no-text-layer" is the one that earns its own sentence -- a
 * scanned worksheet is not a broken file, and telling a student it failed
 * would send them looking for a fault that is not there.
 */
const REFUSALS: Record<UploadRefusal, string> = {
  'too-large': 'That file is too big. The limit is 10MB.',
  'unsupported-type':
    'There is no text in that file to read. Documents, slides, spreadsheets, PDFs, images and anything text-based work; a program or an archive does not.',
  empty: 'There was no text in that file.',
  'nothing-in-it': 'That opened, but there was nothing readable inside it.',
  'no-text-layer':
    'That PDF looks like a scan -- pictures of text rather than text. Send the pictures themselves and they can be read, or export the PDF again with a text layer.',
  unreadable: 'That PDF could not be opened. It may be password-protected or damaged.',
  'image-format':
    'That picture is in a format that cannot be read -- HEIC, which iPhones use by default, is the usual one. A screenshot of it works, or set the camera to "Most Compatible" to shoot JPEG.',
  'no-vision': 'Reading pictures is not switched on for this deployment.',
};
