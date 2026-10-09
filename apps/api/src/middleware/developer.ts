import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { user } from '@contexto/db';
import { ContextoError } from '@contexto/shared';
import type { AppContext } from '../context.js';

/** Whether an email is on the developer list. Case and spacing do not matter. */
export function isDeveloperEmail(list: string | undefined, email: string): boolean {
  if (!list || !email) return false;
  const wanted = email.trim().toLowerCase();
  return list
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .some((e) => e && e === wanted);
}

/**
 * Lets through only the developers named in DEVELOPER_EMAILS.
 *
 * Everyone else -- signed in or not -- gets the same 404 an unknown route
 * would, so the existence of a page full of every student's traces is not
 * something a student can discover by poking at it.
 */
export function requireDeveloper(ctx: AppContext) {
  return createMiddleware<{ Variables: { userId: string } }>(async (c, next) => {
    const notFound = new ContextoError('not_found', 'Not found.');
    const session = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) throw notFound;

    const [row] = await ctx.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, session.user.id))
      .limit(1);
    if (!row || !isDeveloperEmail(ctx.env.DEVELOPER_EMAILS, row.email)) throw notFound;

    c.set('userId', session.user.id);
    await next();
  });
}
