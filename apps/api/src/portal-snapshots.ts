import { and, desc, eq, gt, isNull, notInArray } from 'drizzle-orm';
import type { Database } from '@contexto/db';
import { devices, disabledSites, portalSnapshots, siteRefreshRequests } from '@contexto/db';
import type { BrowserAction, PortalSnapshot, PortalSnapshotSource } from '@contexto/agent';

/**
 * The latest map of each portal a student's devices have captured.
 *
 * DISTINCT ON is the point: a device re-syncs on a schedule, so the table
 * accumulates a history per portal, and the agent only ever wants the newest
 * of each. Doing this in SQL rather than fetching every row and reducing in
 * JavaScript keeps a term's worth of snapshots off the heap.
 */
/**
 * The agent tag only decides which conversation shows the browser, so a value
 * that is not an id is dropped rather than allowed to fail the insert --
 * losing the panel is a far smaller harm than losing the work it decorates.
 */
function isUuid(value: string | undefined): value is string {
  return (
    Boolean(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value!)
  );
}

/** How long a computer can go without a word before it counts as gone. */
const OFFLINE_AFTER_MS = 30_000;

/** "12 seconds ago", "5 minutes ago", "3 hours ago". */
function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  return `${Math.round(minutes / 60)} hours ago`;
}

export class DbPortalSnapshots implements PortalSnapshotSource {
  constructor(private readonly db: Database) {}

  async latest(userId: string): Promise<PortalSnapshot[]> {
    const rows = await this.db
      .selectDistinctOn([portalSnapshots.portalId], {
        portalId: portalSnapshots.portalId,
        origin: portalSnapshots.origin,
        redacted: portalSnapshots.redacted,
        capturedAt: portalSnapshots.capturedAt,
        map: portalSnapshots.map,
      })
      .from(portalSnapshots)
      .where(
        and(
          eq(portalSnapshots.userId, userId),
          /*
           * A site switched off is invisible to the agent, not merely hidden
           * in a settings screen. Filtering here rather than in the caller
           * means every future reader inherits it -- the switch cannot be
           * forgotten by whoever adds the next feature.
           */
          notInArray(
            portalSnapshots.portalId,
            this.db
              .select({ portalId: disabledSites.portalId })
              .from(disabledSites)
              .where(eq(disabledSites.userId, userId)),
          ),
        ),
      )
      .orderBy(portalSnapshots.portalId, desc(portalSnapshots.capturedAt));

    return rows.map((row) => ({
      portalId: row.portalId,
      origin: row.origin,
      redacted: row.redacted,
      capturedAt: row.capturedAt.toISOString(),
      needsLogin: Boolean((row.map as { needsLogin?: boolean })?.needsLogin),
      // The map is stored opaque, so shape it here rather than trusting it.
      pages: Array.isArray((row.map as { pages?: unknown })?.pages)
        ? ((row.map as { pages: PortalSnapshot['pages'] }).pages ?? [])
        : [],
    }));
  }

  async requestBrowse(
    userId: string,
    url: string,
    agentId?: string,
  ): Promise<{ requestId?: string }> {
    const tag = isUuid(agentId) ? agentId : null;
    const [created] = await this.db
      .insert(siteRefreshRequests)
      // portalId is empty for a one-off page: it names a configured site, and
      // this is not one.
      .values({ userId, portalId: '', kind: 'browse', targetUrl: url, agentId: tag })
      .returning({ id: siteRefreshRequests.id });
    return { requestId: created?.id };
  }

  async requestAction(
    userId: string,
    action: BrowserAction,
    agentId?: string,
  ): Promise<{ requestId?: string }> {
    const tag = isUuid(agentId) ? agentId : null;
    const [created] = await this.db
      .insert(siteRefreshRequests)
      .values({ userId, portalId: '', kind: 'act', payload: action, agentId: tag })
      .returning({ id: siteRefreshRequests.id });
    return { requestId: created?.id };
  }

  async resultOf(requestId: string): Promise<unknown> {
    const [row] = await this.db
      .select({ result: siteRefreshRequests.result })
      .from(siteRefreshRequests)
      .where(eq(siteRefreshRequests.id, requestId))
      .limit(1);
    return row?.result ?? null;
  }

  async requestRefresh(
    userId: string,
    portalId: string,
    agentId?: string,
  ): Promise<{ alreadyPending: boolean; requestId?: string }> {
    // De-duplicated: an agent asked twice in a conversation should not make a
    // laptop open two browsers.
    const [pending] = await this.db
      .select({ id: siteRefreshRequests.id })
      .from(siteRefreshRequests)
      .where(
        and(
          eq(siteRefreshRequests.userId, userId),
          eq(siteRefreshRequests.portalId, portalId),
          isNull(siteRefreshRequests.completedAt),
          gt(siteRefreshRequests.requestedAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      )
      .limit(1);

    if (pending) return { alreadyPending: true, requestId: pending.id };

    /*
     * The agent tag only decides which conversation shows the browser. If it
     * is not a real id, drop it rather than let it fail the insert -- losing
     * the panel is a far smaller harm than losing the refresh it was
     * decorating.
     */
    const tag =
      agentId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)
        ? agentId
        : null;
    const [created] = await this.db
      .insert(siteRefreshRequests)
      .values({ userId, portalId, agentId: tag })
      .returning({ id: siteRefreshRequests.id });
    return { alreadyPending: false, requestId: created?.id };
  }

  async awaitRefresh(
    requestId: string,
    timeoutMs: number,
  ): Promise<{
    finished: boolean;
    outcome?: string | null;
    why?: { code: string; message: string };
  }> {
    const deadline = Date.now() + timeoutMs;
    /*
     * Polled rather than pushed. The work happens on a machine that reaches
     * out to us and cannot be reached back, so there is nothing to listen to
     * -- and a query on an indexed primary key every second is cheaper than
     * the machinery that would avoid it.
     */
    while (Date.now() < deadline) {
      const [row] = await this.db
        .select({
          completedAt: siteRefreshRequests.completedAt,
          outcome: siteRefreshRequests.outcome,
        })
        .from(siteRefreshRequests)
        .where(eq(siteRefreshRequests.id, requestId))
        .limit(1);

      if (row?.completedAt) return { finished: true, outcome: row.outcome };
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { finished: false, why: await this.whyNotFinished(requestId) };
  }

  /**
   * Why a request is still open when the wait ran out.
   *
   * Read off what the student's computer last told us: when it was last in
   * touch, what its heartbeat said it was busy with, and whether it ever
   * collected this request. "Asleep" is one of five answers, not the only one.
   */
  async whyNotFinished(requestId: string): Promise<{ code: string; message: string }> {
    const [request] = await this.db
      .select({ userId: siteRefreshRequests.userId, pickedUpAt: siteRefreshRequests.pickedUpAt })
      .from(siteRefreshRequests)
      .where(eq(siteRefreshRequests.id, requestId))
      .limit(1);
    if (!request) {
      return { code: 'transport.no_report', message: 'The request is no longer there.' };
    }

    const machines = await this.db
      .select({ lastSeenAt: devices.lastSeenAt, state: devices.state, stateAt: devices.stateAt })
      .from(devices)
      .where(and(eq(devices.userId, request.userId), isNull(devices.revokedAt)))
      .orderBy(desc(devices.lastSeenAt));
    const latest = machines[0];
    if (!latest) {
      return {
        code: 'transport.no_device',
        message: 'No computer of theirs is linked, so nothing could do this.',
      };
    }

    const now = Date.now();
    const seenAgo = latest.lastSeenAt ? now - latest.lastSeenAt.getTime() : Infinity;
    if (request.pickedUpAt) {
      return {
        code: 'transport.no_report',
        message:
          `Their computer started this ${ago(now - request.pickedUpAt.getTime())} and has not ` +
          'reported back. It may still be working -- a sign-in can take a minute -- or the ' +
          'report was lost on the way. Look again rather than assuming it failed.',
      };
    }
    if (seenAgo > OFFLINE_AFTER_MS) {
      return {
        code: 'transport.offline',
        message: Number.isFinite(seenAgo)
          ? `Their computer was last in touch ${ago(seenAgo)}: it is asleep, shut, or offline.`
          : 'Their computer has never been in touch since it was linked.',
      };
    }
    const busy = (
      latest.state as { busy?: { kind?: string; portalId?: string | null; since?: string } } | null
    )?.busy;
    if (busy) {
      const what = busy.portalId ? `${busy.kind} of ${busy.portalId}` : busy.kind;
      const since = busy.since ? ` (started ${ago(now - Date.parse(busy.since))})` : '';
      return {
        code: 'transport.busy',
        message:
          `Their computer is busy with another browser job -- ${what}${since} -- and will get ` +
          'to this when it finishes.',
      };
    }
    return {
      code: 'transport.not_picked_up',
      message:
        'Their computer is online and idle but has not collected this request. That is a fault ' +
        'in Contexto, not something the student did; say so, and offer to try again.',
    };
  }
}
