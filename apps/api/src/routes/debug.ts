import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { browserAttempts, siteRefreshRequests, user } from '@contexto/db';
import { ContextoError } from '@contexto/shared';
import type { AppContext } from '../context.js';
import { requireDeveloper } from '../middleware/developer.js';

/**
 * What the desktop app recorded about its browser work, for developers.
 *
 * Every student's traces, which is why every route here sits behind
 * requireDeveloper and answers 404 to anyone else. The list leaves the
 * screenshots out -- they are the bulk of a row -- and the detail carries one.
 */
export function createDebugRoutes(ctx: AppContext) {
  const developer = requireDeveloper(ctx);

  return new Hono<{ Variables: { userId: string } }>()
    .get(
      '/attempts',
      developer,
      zValidator(
        'query',
        z.object({
          failed: z.enum(['0', '1']).optional(),
          code: z.string().max(80).optional(),
          email: z.string().max(320).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(50),
        }),
      ),
      async (c) => {
        const q = c.req.valid('query');
        const where: SQL[] = [];
        if (q.failed === '1') where.push(eq(browserAttempts.outcome, 'failed'));
        if (q.code) where.push(eq(browserAttempts.code, q.code));
        if (q.email) where.push(eq(user.email, q.email));

        const rows = await ctx.db
          .select({
            id: browserAttempts.id,
            email: user.email,
            kind: browserAttempts.kind,
            portalId: browserAttempts.portalId,
            target: browserAttempts.target,
            outcome: browserAttempts.outcome,
            code: browserAttempts.code,
            message: browserAttempts.message,
            startedAt: browserAttempts.startedAt,
            endedAt: browserAttempts.endedAt,
            screenshot: browserAttempts.screenshot,
          })
          .from(browserAttempts)
          .innerJoin(user, eq(user.id, browserAttempts.userId))
          .where(where.length ? and(...where) : undefined)
          .orderBy(desc(browserAttempts.startedAt))
          .limit(q.limit);

        return c.json(
          rows.map(({ screenshot, ...row }) => ({
            ...row,
            durationMs: row.endedAt.getTime() - row.startedAt.getTime(),
            hasScreenshot: Boolean(screenshot),
          })),
        );
      },
    )

    .get('/attempts/:id', developer, async (c) => {
      const id = c.req.param('id');
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ContextoError('not_found', 'No such attempt.');

      const [row] = await ctx.db
        .select({ attempt: browserAttempts, email: user.email })
        .from(browserAttempts)
        .innerJoin(user, eq(user.id, browserAttempts.userId))
        .where(eq(browserAttempts.id, id))
        .limit(1);
      if (!row) throw new ContextoError('not_found', 'No such attempt.');

      const [request] = row.attempt.requestId
        ? await ctx.db
            .select({
              kind: siteRefreshRequests.kind,
              outcome: siteRefreshRequests.outcome,
              requestedAt: siteRefreshRequests.requestedAt,
              pickedUpAt: siteRefreshRequests.pickedUpAt,
              completedAt: siteRefreshRequests.completedAt,
            })
            .from(siteRefreshRequests)
            .where(eq(siteRefreshRequests.id, row.attempt.requestId))
            .limit(1)
        : [];

      return c.json({
        ...row.attempt,
        email: row.email,
        durationMs: row.attempt.endedAt.getTime() - row.attempt.startedAt.getTime(),
        request: request ?? null,
      });
    });
}
