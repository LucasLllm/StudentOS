import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/**
 * Desktop companions, and what they bring back.
 *
 * The droplet cannot reach a student's laptop -- it is behind NAT with no
 * public address -- so the connection is made the other way round: the desktop
 * app authenticates outward and pushes what it finds. That also means portal
 * data is already here when the agent is asked about it at midnight with the
 * laptop shut, which a pull-based design could never manage.
 */

/**
 * A short-lived link request, so a student never handles a raw token.
 *
 * The desktop app opens the browser at /link/<request_id>; the student, already
 * signed in, approves; the app polls and collects a token. Modelled on the
 * OAuth device grant, minus the parts we do not need.
 */
export const deviceLinkRequests = pgTable('device_link_requests', {
  /** Long random value. The only thing the desktop app holds before approval. */
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  deviceName: text('device_name').notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  /**
   * Set the moment a token is issued. A request is redeemable exactly once, so
   * a leaked link cannot be replayed into a second token.
   */
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A linked desktop install. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * SHA-256 of the token, never the token. A dump of this table does not let
     * anyone speak as a student's laptop.
     */
    tokenHash: text('token_hash').notNull().unique(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('devices_user_id_idx').on(t.userId),
    index('devices_token_hash_idx').on(t.tokenHash),
  ],
);

/**
 * The most recent map of a portal, stored whole.
 *
 * Deliberately opaque JSON rather than modelled courses and assignments. We
 * have seen exactly one Veracross response so far and it was empty, because the
 * school year has not started. Designing tables around imagined coursework
 * would bake in guesses; storing what the portal actually returned lets the
 * shape be read off real data once term begins.
 */
export const portalSnapshots = pgTable(
  'portal_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** Stable key for the portal, e.g. 'veracross'. */
    portalId: text('portal_id').notNull(),
    origin: text('origin').notNull(),
    /**
     * Whether values were captured, or only shapes. `.default()` rather than
     * `.$defaultFn()` on purpose -- the latter generates ADD COLUMN NOT NULL
     * with no DEFAULT, which fails against a table that already has rows.
     */
    redacted: boolean('redacted').notNull().default(true),
    map: jsonb('map').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('portal_snapshots_user_portal_idx').on(t.userId, t.portalId, t.capturedAt)],
);

/**
 * Sites a student has switched OFF.
 *
 * Exceptions only, the same shape as disabled integrations: no row means the
 * agent may read it. Off is not the same as removed -- the captured pages stay
 * put and the device keeps syncing, so turning it back on is instant and costs
 * no re-login. Removing is the destructive one.
 */
export const disabledSites = pgTable(
  'disabled_sites',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    portalId: text('portal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.portalId] })],
);

/**
 * The agent asking a student's computer to go and look again.
 *
 * The credential that reaches a site lives on that machine and never leaves
 * it, so the agent cannot fetch anything itself -- it leaves a request here
 * and the device picks it up. That inversion is the whole point: the server
 * holds what was found, never the means to find it.
 *
 * Rows are short-lived. A request nobody collected within the hour is a
 * laptop that was closed, not work still owed.
 */
export const siteRefreshRequests = pgTable(
  'site_refresh_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Which configured site, for a refresh. Empty for a one-off page. */
    portalId: text('portal_id').notNull(),
    /**
     * What the agent asked for.
     *
     * 'refresh' signs into a configured site and reads it. 'browse' opens one
     * page and reads it back -- the same browser, doing ordinary work, which
     * is why the student sees it either way. 'act' does one thing on the page
     * the last browse left open -- a click, some typing -- and reads it again.
     */
    kind: text('kind').notNull().default('refresh'),
    /** The page to open, for a browse. */
    targetUrl: text('target_url'),
    /**
     * What to do on the page, for an act: the action and what it aims at.
     * Opaque here; checked by the agent that wrote it and the app that does it.
     */
    payload: jsonb('payload'),
    /**
     * What came back. Kept on the request rather than in portal_snapshots
     * because a one-off page is not a site the student has connected, and
     * storing it as one would make it look connected.
     */
    result: jsonb('result'),
    /**
     * Which agent asked, so the browser it opens can be shown in that
     * conversation and nowhere else. Nullable: a scheduled sync has no agent
     * behind it and nothing to show it in.
     */
    agentId: uuid('agent_id'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** What the device made of it: 'synced' | 'needs_login' | 'failed'. */
    outcome: text('outcome'),
  },
  (t) => [index('site_refresh_user_idx').on(t.userId, t.portalId, t.requestedAt)],
);
