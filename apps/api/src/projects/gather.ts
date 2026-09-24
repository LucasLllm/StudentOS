import { eq } from 'drizzle-orm';
import { projects } from '@contexto/db';
import type { AppContext } from '../context.js';

/** Placeholder until the sweep lands: marks a new project as gathered. */
export function startGathering(
  ctx: AppContext,
  input: { userId: string; projectId: string },
): void {
  void ctx.db
    .update(projects)
    .set({ gatheredAt: new Date() })
    .where(eq(projects.id, input.projectId))
    .catch(() => undefined);
  void input.userId;
}
