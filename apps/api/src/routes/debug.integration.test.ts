import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { browserAttempts, siteRefreshRequests } from '@contexto/db';
import { createAuth } from '../auth.js';
import { handleError } from '../errors.js';
import { createRoutes } from './index.js';
import type { AppContext } from '../context.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { createUser, reset, testDb, TEST_DATABASE_URL } from '../test-support/harness.js';

/**
 * The debug page reads every student's browser traces, screenshots included,
 * so the one property that matters most is who can reach it: developers named
 * in DEVELOPER_EMAILS, and nobody else -- not even by learning it exists.
 */

let app: Hono;
let db: Awaited<ReturnType<typeof testDb>>;
let developerEmail = '';

beforeAll(async () => {
  db = await testDb();
});

beforeEach(async () => {
  resetRateLimits();
  await reset();
});

/** A fresh app whose developer list names `email`. */
function appFor(email: string) {
  const env = {
    NODE_ENV: 'test' as const,
    PORT: 0,
    DATABASE_URL: TEST_DATABASE_URL,
    API_BASE_URL: 'http://localhost:3000',
    WEB_BASE_URL: 'http://localhost:5173',
    AUTH_SECRET: 'x'.repeat(40),
    MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    // Mixed case and spacing, the way it gets typed into a .env.
    DEVELOPER_EMAILS: ` someone@else.test , ${email.toUpperCase()} `,
  };
  const ctx = { env, db, auth: createAuth(db, env as never), telegram: undefined };
  return new Hono().route('/api', createRoutes(ctx as unknown as AppContext)).onError(handleError);
}

const as = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

async function seedAttempt(userId: string, overrides: Record<string, unknown> = {}) {
  const [request] = await db
    .insert(siteRefreshRequests)
    .values({ userId, portalId: '', kind: 'browse', targetUrl: 'https://a.test/' })
    .returning({ id: siteRefreshRequests.id });
  const id = randomUUID();
  await db.insert(browserAttempts).values({
    id,
    userId,
    requestId: request!.id,
    kind: 'browse',
    target: 'https://a.test/',
    outcome: 'failed',
    code: 'nav.dns',
    message: 'That address does not exist.',
    steps: [{ t: 0, name: 'nav.start' }],
    screenshot: 'data:image/jpeg;base64,AAAA',
    startedAt: new Date('2026-10-09T12:00:00Z'),
    endedAt: new Date('2026-10-09T12:00:02Z'),
    ...overrides,
  });
  return id;
}

describe('the debug routes', () => {
  it('do not exist for a student who is not a developer', async () => {
    const dev = await createUser();
    const student = await createUser();
    app = appFor(dev.email);
    const id = await seedAttempt(student.id);
    expect((await app.request('/api/debug/attempts', as(student.token))).status).toBe(404);
    expect((await app.request(`/api/debug/attempts/${id}`, as(student.token))).status).toBe(404);
  });

  it('do not exist without a session', async () => {
    const dev = await createUser();
    app = appFor(dev.email);
    expect((await app.request('/api/debug/attempts')).status).toBe(404);
  });

  it('list every student’s attempts for a developer, newest first, with who', async () => {
    const dev = await createUser();
    const student = await createUser();
    developerEmail = dev.email;
    app = appFor(developerEmail);
    await seedAttempt(student.id, { startedAt: new Date('2026-10-09T12:00:00Z') });
    await seedAttempt(student.id, {
      outcome: 'ok',
      code: null,
      message: null,
      screenshot: null,
      startedAt: new Date('2026-10-09T13:00:00Z'),
    });

    const all = (await (await app.request('/api/debug/attempts', as(dev.token))).json()) as {
      email: string;
      outcome: string;
      durationMs: number;
      hasScreenshot: boolean;
      screenshot?: unknown;
    }[];
    expect(all.map((a) => a.outcome)).toEqual(['ok', 'failed']);
    expect(all[1]).toMatchObject({ email: student.email, durationMs: 2000, hasScreenshot: true });
    expect(all[1]!.screenshot).toBeUndefined();

    const failed = (await (
      await app.request('/api/debug/attempts?failed=1', as(dev.token))
    ).json()) as unknown[];
    expect(failed).toHaveLength(1);

    const byCode = (await (
      await app.request('/api/debug/attempts?code=nav.dns', as(dev.token))
    ).json()) as unknown[];
    expect(byCode).toHaveLength(1);
  });

  it('show one attempt in full, with the request it answered', async () => {
    const dev = await createUser();
    const student = await createUser();
    app = appFor(dev.email);
    const id = await seedAttempt(student.id);
    const res = await app.request(`/api/debug/attempts/${id}`, as(dev.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id,
      email: student.email,
      code: 'nav.dns',
      steps: [{ t: 0, name: 'nav.start' }],
      screenshot: 'data:image/jpeg;base64,AAAA',
      request: { kind: 'browse' },
    });
  });

  it('tell the web app who is a developer', async () => {
    const dev = await createUser();
    const student = await createUser();
    app = appFor(dev.email);
    const me = async (token: string) =>
      ((await (await app.request('/api/me', as(token))).json()) as { developer?: boolean })
        .developer;
    expect(await me(dev.token)).toBe(true);
    expect(await me(student.token)).toBe(false);
  });
});
