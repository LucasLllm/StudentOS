import { and, desc, eq, gt, isNull, notInArray } from 'drizzle-orm';
import type { Database } from '@contexto/db';
import { disabledSites, portalSnapshots, siteRefreshRequests } from '@contexto/db';
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
  ): Promise<{ finished: boolean; outcome?: string | null }> {
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
    return { finished: false };
  }
}
