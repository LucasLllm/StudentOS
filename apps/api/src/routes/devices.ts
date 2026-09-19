import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gt, isNotNull, isNull, lt, ne, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  deviceLinkRequests,
  devices,
  disabledSites,
  portalSnapshots,
  siteRefreshRequests,
} from '@contexto/db';
import { ContextoError } from '@contexto/shared';
import type { AppContext } from '../context.js';
import { HOSTNAME, lookupSiteIcon } from '../site-icon.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { hashDeviceToken, requireDevice, type DeviceVariables } from '../middleware/device.js';

const LINK_TTL_MS = 10 * 60 * 1000;

/** History kept per portal. Only the newest is ever read. */
const SNAPSHOTS_KEPT = 5;

/**
 * How long a refresh request stays worth doing.
 *
 * A request nobody collected within the hour is a laptop that was closed, not
 * work still owed -- running it on the next launch would fetch data for a
 * question asked long ago.
 */
const REFRESH_TTL_MS = 60 * 60 * 1000;

/**
 * Ceiling on one pushed snapshot.
 *
 * A forty-page portal with real values runs to a few hundred kilobytes, so
 * this is generous. It exists because nothing else bounds it: the body is
 * parsed into memory and then stored as JSONB, so a device with a runaway
 * crawl -- or one that has been tampered with, since it runs on a machine we
 * do not control -- could otherwise push until the API runs out of memory.
 */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/**
 * Linking a desktop companion, and receiving what it finds.
 *
 * The link flow never shows a student a token. The app opens their browser at
 * /link/<id>, they approve inside a session they already have, and the app
 * exchanges the same id for a token it keeps to itself. A student who is
 * phished out of the link URL loses nothing on its own: approval requires
 * being signed in, and the exchange happens once.
 */
export function createDeviceRoutes(ctx: AppContext) {
  const auth = requireAuth(ctx);
  const device = requireDevice(ctx);

  return (
    new Hono<{ Variables: AuthVariables & DeviceVariables }>()
      /**
       * Step 1, from the desktop app. Unauthenticated by necessity -- the app
       * has no credentials yet, which is the entire problem being solved.
       */
      .post(
        '/link/start',
        // The only unauthenticated route here that writes rows. Linking a
        // computer is something a person does rarely, so a low ceiling costs
        // nobody anything and keeps this from being trivially spammable.
        rateLimit({ limit: 10, windowMs: 10 * 60 * 1000 }),
        zValidator('json', z.object({ deviceName: z.string().min(1).max(80) })),
        async (c) => {
          const { deviceName } = c.req.valid('json');

          // Requests are dead ten minutes after they are made and nothing
          // else ever deletes them. Swept here, at the only place they are
          // created, so the table stays roughly one window deep.
          await ctx.db
            .delete(deviceLinkRequests)
            .where(lt(deviceLinkRequests.expiresAt, new Date()));
          const [request] = await ctx.db
            .insert(deviceLinkRequests)
            .values({ deviceName, expiresAt: new Date(Date.now() + LINK_TTL_MS) })
            .returning({ id: deviceLinkRequests.id, expiresAt: deviceLinkRequests.expiresAt });

          if (!request)
            throw new ContextoError('internal_error', 'Could not start device linking.');
          return c.json({ requestId: request.id, expiresAt: request.expiresAt });
        },
      )

      /** Step 2, from the browser: what am I being asked to approve? */
      .get('/link/:id', auth, async (c) => {
        const [request] = await ctx.db
          .select({
            deviceName: deviceLinkRequests.deviceName,
            approvedAt: deviceLinkRequests.approvedAt,
          })
          .from(deviceLinkRequests)
          .where(
            and(
              eq(deviceLinkRequests.id, c.req.param('id')),
              gt(deviceLinkRequests.expiresAt, new Date()),
              isNull(deviceLinkRequests.consumedAt),
            ),
          )
          .limit(1);

        if (!request) throw new ContextoError('not_found', 'That link request has expired.');
        return c.json(request);
      })

      /** Step 3, from the browser: yes, this is my computer. */
      .post('/link/:id/approve', auth, async (c) => {
        const updated = await ctx.db
          .update(deviceLinkRequests)
          .set({ userId: c.get('userId'), approvedAt: new Date() })
          .where(
            and(
              eq(deviceLinkRequests.id, c.req.param('id')),
              gt(deviceLinkRequests.expiresAt, new Date()),
              isNull(deviceLinkRequests.consumedAt),
              isNull(deviceLinkRequests.approvedAt),
            ),
          )
          .returning({ id: deviceLinkRequests.id });

        if (updated.length === 0)
          throw new ContextoError('not_found', 'That link request has expired.');
        return c.json({ ok: true });
      })

      /**
       * Step 4, from the desktop app, polling. Issues the token exactly once.
       *
       * The whole claim is one conditional UPDATE that requires the request to
       * be unexpired, unconsumed AND already approved. Two racing polls both
       * attempt the same write and Postgres matches the row for only one of
       * them, so a second token cannot be minted from one approval. Checking
       * those conditions in JavaScript and then writing would leave a window
       * between the read and the write where both callers believe they won.
       */
      .post('/link/:id/claim', async (c) => {
        const requestId = c.req.param('id');
        const [claimed] = await ctx.db
          .update(deviceLinkRequests)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(deviceLinkRequests.id, requestId),
              gt(deviceLinkRequests.expiresAt, new Date()),
              isNull(deviceLinkRequests.consumedAt),
              isNotNull(deviceLinkRequests.approvedAt),
              isNotNull(deviceLinkRequests.userId),
            ),
          )
          .returning({
            userId: deviceLinkRequests.userId,
            deviceName: deviceLinkRequests.deviceName,
          });

        if (!claimed?.userId) {
          // Nothing was claimable. Distinguish "keep polling" from "give up"
          // without revealing anything about ids that were never ours.
          const [pending] = await ctx.db
            .select({ id: deviceLinkRequests.id })
            .from(deviceLinkRequests)
            .where(
              and(
                eq(deviceLinkRequests.id, requestId),
                gt(deviceLinkRequests.expiresAt, new Date()),
                isNull(deviceLinkRequests.consumedAt),
              ),
            )
            .limit(1);

          if (pending) return c.json({ status: 'pending' as const });
          throw new ContextoError('not_found', 'That link request has expired.');
        }

        const token = randomBytes(32).toString('base64url');
        const [created] = await ctx.db
          .insert(devices)
          .values({
            userId: claimed.userId,
            name: claimed.deviceName,
            tokenHash: hashDeviceToken(token),
          })
          .returning({ id: devices.id });

        if (!created) throw new ContextoError('internal_error', 'Could not register this device.');

        /*
         * Linking again from the same machine replaces, rather than adds.
         *
         * A student who re-links -- after reinstalling, or because a session
         * went wrong -- ends up with two rows of the same computer name, one
         * of which can never sync again because its token exists nowhere.
         * Both offer an Unlink button and neither says which is which.
         *
         * Matched on name because that is what identifies a machine to the
         * person reading the list; the older row is revoked rather than
         * deleted, so the history of what was linked when survives.
         */
        await ctx.db
          .update(devices)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(devices.userId, claimed.userId),
              eq(devices.name, claimed.deviceName),
              isNull(devices.revokedAt),
              ne(devices.id, created.id),
            ),
          );

        /*
         * A session for the app, minted here rather than asked for again.
         *
         * The student just proved who they are, in a browser, to approve this
         * exact request. Sending them through Google a second time inside the
         * app would be asking the same question twice -- and the answer is
         * already on the row we just consumed.
         *
         * It travels as a bearer token, which is why the bearer plugin exists
         * in auth.ts. The device token and this session are separate on
         * purpose: revoking the device stops it syncing, and signing out
         * elsewhere ends the session, without either implying the other.
         */
        const authContext = await ctx.auth.$context;
        const session = await authContext.internalAdapter.createSession(claimed.userId, undefined);

        return c.json({
          status: 'linked' as const,
          token,
          deviceId: created.id,
          sessionToken: session.token,
        });
      })

      /**
       * A fresh session for a device that already has one approved.
       *
       * Sessions expire; device links do not. Without this the app would send
       * a student back through linking every time their session aged out,
       * which is a worse question than the one they already answered.
       *
       * The escalation is real and worth naming: a stolen device token can
       * mint sessions for as long as the device is linked. It could already
       * read everything that device syncs, and revoking the device ends both
       * at once -- which is why revocation is one click in Settings.
       */
      .post('/session', device, async (c) => {
        const authContext = await ctx.auth.$context;
        const session = await authContext.internalAdapter.createSession(c.get('userId'), undefined);
        return c.json({ sessionToken: session.token });
      })

      /**
       * Ask the student's computer to look at a site again.
       *
       * Queued rather than performed: the credential that gets past a login
       * lives on that machine, so this server can only ask. It de-duplicates
       * on purpose -- an agent that asks three times in a minute should not
       * make a laptop open three browsers.
       */
      .post('/sites/:portalId/refresh', auth, async (c) => {
        const userId = c.get('userId');
        const portalId = c.req.param('portalId');

        const [pending] = await ctx.db
          .select({ id: siteRefreshRequests.id })
          .from(siteRefreshRequests)
          .where(
            and(
              eq(siteRefreshRequests.userId, userId),
              eq(siteRefreshRequests.portalId, portalId),
              isNull(siteRefreshRequests.completedAt),
              gt(siteRefreshRequests.requestedAt, new Date(Date.now() - REFRESH_TTL_MS)),
            ),
          )
          .limit(1);

        if (pending) return c.json({ queued: true, requestId: pending.id, alreadyPending: true });

        const [created] = await ctx.db
          .insert(siteRefreshRequests)
          .values({ userId, portalId })
          .returning({ id: siteRefreshRequests.id });

        if (!created) throw new ContextoError('internal_error', 'Could not ask for a refresh.');
        return c.json({ queued: true, requestId: created.id, alreadyPending: false });
      })

      /** What a device should go and do. Polled by the desktop app. */
      .get('/pending', device, async (c) => {
        const rows = await ctx.db
          .select({
            id: siteRefreshRequests.id,
            portalId: siteRefreshRequests.portalId,
            kind: siteRefreshRequests.kind,
            targetUrl: siteRefreshRequests.targetUrl,
            payload: siteRefreshRequests.payload,
            agentId: siteRefreshRequests.agentId,
          })
          .from(siteRefreshRequests)
          .where(
            and(
              eq(siteRefreshRequests.userId, c.get('userId')),
              isNull(siteRefreshRequests.completedAt),
              gt(siteRefreshRequests.requestedAt, new Date(Date.now() - REFRESH_TTL_MS)),
            ),
          )
          .orderBy(siteRefreshRequests.requestedAt);

        return c.json(rows);
      })

      /** The device reporting back on one of them. */
      .post(
        '/pending/:id/complete',
        device,
        // Bounded, because the page a device read comes back through here and
        // is as untrusted as anything else it fetched.
        bodyLimit({
          maxSize: MAX_SNAPSHOT_BYTES,
          onError: () => {
            throw new ContextoError('validation_failed', 'That page is too large to return.');
          },
        }),
        zValidator(
          'json',
          z.object({
            outcome: z.enum(['synced', 'needs_login', 'failed', 'read']),
            result: z.unknown().optional(),
          }),
        ),
        async (c) => {
          const body = c.req.valid('json');
          await ctx.db
            .update(siteRefreshRequests)
            .set({
              completedAt: new Date(),
              outcome: body.outcome,
              result: body.result ?? null,
            })
            .where(
              and(
                eq(siteRefreshRequests.id, c.req.param('id')),
                // Scoped to the caller: a device may only close its own
                // student's requests, never another's.
                eq(siteRefreshRequests.userId, c.get('userId')),
              ),
            );
          return c.json({ ok: true });
        },
      )

      /** Linked devices, for Settings. */
      .get('/', auth, async (c) => {
        const rows = await ctx.db
          .select({
            id: devices.id,
            name: devices.name,
            lastSeenAt: devices.lastSeenAt,
            createdAt: devices.createdAt,
          })
          .from(devices)
          .where(and(eq(devices.userId, c.get('userId')), isNull(devices.revokedAt)))
          .orderBy(desc(devices.createdAt));

        return c.json(rows);
      })

      /**
       * Sites a linked computer has captured, for the web app.
       *
       * Read-only and metadata only -- what is connected and how fresh it is.
       * The contents belong to the agent, not to a settings screen.
       */
      .get('/sites', auth, async (c) => {
        const rows = await ctx.db
          .selectDistinctOn([portalSnapshots.portalId], {
            portalId: portalSnapshots.portalId,
            origin: portalSnapshots.origin,
            capturedAt: portalSnapshots.capturedAt,
            map: portalSnapshots.map,
          })
          .from(portalSnapshots)
          .where(eq(portalSnapshots.userId, c.get('userId')))
          .orderBy(portalSnapshots.portalId, desc(portalSnapshots.capturedAt));

        const off = new Set(
          (
            await ctx.db
              .select({ portalId: disabledSites.portalId })
              .from(disabledSites)
              .where(eq(disabledSites.userId, c.get('userId')))
          ).map((row) => row.portalId),
        );

        return c.json(
          rows.map((row) => ({
            portalId: row.portalId,
            origin: row.origin,
            capturedAt: row.capturedAt,
            enabled: !off.has(row.portalId),
            needsLogin: Boolean((row.map as { needsLogin?: boolean })?.needsLogin),
            pages: Array.isArray((row.map as { pages?: unknown[] })?.pages)
              ? (row.map as { pages: unknown[] }).pages.length
              : 0,
          })),
        );
      })

      /**
       * A custom site's mark, for the settings page.
       *
       * Second in the chain: the browser has already asked the site itself
       * for /favicon.ico and got nothing usable. See site-icon.ts for why
       * the lookup has to be read from here rather than from an <img>.
       */
      .get(
        '/sites/icon',
        auth,
        zValidator('query', z.object({ host: z.string().regex(HOSTNAME) })),
        async (c) => {
          const icon = await lookupSiteIcon(c.req.valid('query').host);
          if (!icon) return c.body(null, 404);
          return c.body(icon.bytes, 200, {
            'Content-Type': icon.type,
            // A day: marks change rarely, and the page is opened often.
            'Cache-Control': 'private, max-age=86400',
          });
        },
      )

      /** Switch a site off or back on. Off keeps the pages; remove deletes them. */
      .post(
        '/sites/:portalId/enabled',
        auth,
        zValidator('json', z.object({ enabled: z.boolean() })),
        async (c) => {
          const userId = c.get('userId');
          const portalId = c.req.param('portalId');

          if (c.req.valid('json').enabled) {
            await ctx.db
              .delete(disabledSites)
              .where(and(eq(disabledSites.userId, userId), eq(disabledSites.portalId, portalId)));
          } else {
            await ctx.db.insert(disabledSites).values({ userId, portalId }).onConflictDoNothing();
          }
          return c.json({ ok: true });
        },
      )

      /**
       * Forget a site entirely.
       *
       * Deletes the captured pages, not just the switch. The device may sync it
       * again -- this removes what the server holds, which is the part a
       * student is asking about when they say remove.
       */
      .delete('/sites/:portalId', auth, async (c) => {
        const userId = c.get('userId');
        const portalId = c.req.param('portalId');
        await ctx.db
          .delete(portalSnapshots)
          .where(and(eq(portalSnapshots.userId, userId), eq(portalSnapshots.portalId, portalId)));
        await ctx.db
          .delete(disabledSites)
          .where(and(eq(disabledSites.userId, userId), eq(disabledSites.portalId, portalId)));
        return c.json({ ok: true });
      })

      .post('/:id/revoke', auth, async (c) => {
        await ctx.db
          .update(devices)
          .set({ revokedAt: new Date() })
          .where(and(eq(devices.id, c.req.param('id')), eq(devices.userId, c.get('userId'))));
        return c.json({ ok: true });
      })

      /**
       * A portal map, pushed up by a linked device.
       *
       * Stored whole and opaque. We have seen one real Veracross response and
       * it was empty because term has not started; modelling courses and
       * assignments now would be modelling a guess.
       */
      .post(
        '/portal-snapshot',
        // Before the device lookup and before parsing: an oversized body should
        // cost a header read, not a database round trip.
        bodyLimit({
          maxSize: MAX_SNAPSHOT_BYTES,
          onError: () => {
            throw new ContextoError(
              'validation_failed',
              'That portal snapshot is too large to store.',
            );
          },
        }),
        device,
        zValidator(
          'json',
          z.object({
            portalId: z.string().regex(/^[a-z0-9-]+$/),
            /*
             * http(s) only. z.url() checks URL syntax, not scheme, so it
             * happily accepts javascript: and data: -- and this value comes
             * from a machine we do not control and is shown back to the
             * student as the name of a site. Nothing renders it as a link
             * today; this is so that staying true never depends on nobody
             * ever doing so.
             */
            origin: z.url().refine(
              (value) => {
                // Must not throw: a validator that raises turns a rejected
                // input into a 500, which reads as our fault rather than the
                // caller's.
                try {
                  return /^https?:$/.test(new URL(value).protocol);
                } catch {
                  return false;
                }
              },
              { message: 'origin must be http or https' },
            ),
            redacted: z.boolean(),
            capturedAt: z.iso.datetime(),
            map: z.unknown(),
          }),
        ),
        async (c) => {
          const body = c.req.valid('json');
          const [saved] = await ctx.db
            .insert(portalSnapshots)
            .values({
              userId: c.get('userId'),
              deviceId: c.get('deviceId'),
              portalId: body.portalId,
              origin: body.origin,
              redacted: body.redacted,
              capturedAt: new Date(body.capturedAt),
              map: body.map,
            })
            .returning({ id: portalSnapshots.id });

          if (!saved)
            throw new ContextoError('internal_error', 'Could not store the portal snapshot.');

          /*
           * Keep a short history and drop the rest.
           *
           * A device syncs every six hours, so an unbounded table grows by
           * about 1,500 rows per portal per student per year, each holding a
           * whole portal as JSONB. Nothing reads past the newest -- the agent
           * asks for the latest per portal -- so the older rows are pure
           * storage cost. A few are kept because "it worked yesterday" is the
           * first question when a sync starts coming back empty.
           *
           * Pruned inline rather than on a schedule: this is the only place
           * rows are created, so it cannot fall behind, and there is no cron
           * to forget to deploy.
           */
          await ctx.db.delete(portalSnapshots).where(
            and(
              eq(portalSnapshots.userId, c.get('userId')),
              eq(portalSnapshots.portalId, body.portalId),
              notInArray(
                portalSnapshots.id,
                ctx.db
                  .select({ id: portalSnapshots.id })
                  .from(portalSnapshots)
                  .where(
                    and(
                      eq(portalSnapshots.userId, c.get('userId')),
                      eq(portalSnapshots.portalId, body.portalId),
                    ),
                  )
                  .orderBy(desc(portalSnapshots.capturedAt))
                  .limit(SNAPSHOTS_KEPT),
              ),
            ),
          );

          return c.json({ ok: true, snapshotId: saved.id });
        },
      )
  );
}
