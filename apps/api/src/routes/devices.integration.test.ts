import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createAuth } from '../auth.js';
import { handleError } from '../errors.js';
import { createRoutes } from './index.js';
import type { AppContext } from '../context.js';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  browserAttempts,
  deviceLinkRequests,
  devices,
  portalSnapshots,
  siteRefreshRequests,
} from '@contexto/db';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { createUser, reset, testDb, TEST_DATABASE_URL } from '../test-support/harness.js';

/**
 * Device linking, and what a linked device may reach.
 *
 * A device token is a standing credential for a student's account held on a
 * laptop, so the two properties worth the most here are that one approval
 * mints exactly one token, and that a token belonging to one student can never
 * read or write another's portal data.
 */

let app: Hono;
let db: Awaited<ReturnType<typeof testDb>>;

beforeAll(async () => {
  db = await testDb();
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
  };
  const ctx = {
    env,
    db,
    auth: createAuth(db, env as never),
    telegram: undefined,
  } as unknown as AppContext;
  app = new Hono().route('/api', createRoutes(ctx)).onError(handleError);
});

beforeEach(async () => {
  resetRateLimits();
  await reset();
});

const as = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const json = (body: unknown, token?: string) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

async function startLink(name = 'Test Laptop') {
  const res = await app.request('/api/devices/link/start', json({ deviceName: name }));
  return (await res.json()) as { requestId: string };
}

async function linkDevice(userToken: string, name = 'Test Laptop') {
  const { requestId } = await startLink(name);
  await app.request(`/api/devices/link/${requestId}/approve`, json({}, userToken));
  const res = await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' });
  return (await res.json()) as { status: string; token: string; deviceId: string };
}

describe('linking', () => {
  it('does not issue a token before the student approves', async () => {
    const { requestId } = await startLink();
    const res = await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' });
    expect(await res.json()).toEqual({ status: 'pending' });
  });

  it('issues a token after approval', async () => {
    const alice = await createUser();
    const result = await linkDevice(alice.token);
    expect(result.status).toBe('linked');
    expect(result.token).toEqual(expect.any(String));
  });

  it('issues exactly one token per approval', async () => {
    const alice = await createUser();
    const { requestId } = await startLink();
    await app.request(`/api/devices/link/${requestId}/approve`, json({}, alice.token));

    // Both claims race the same conditional UPDATE; only one row can match.
    const [first, second] = await Promise.all([
      app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' }),
      app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' }),
    ]);
    const results = (await Promise.all([first.json(), second.json()])) as { status: string }[];
    expect(results.filter((r) => r.status === 'linked')).toHaveLength(1);
  });

  it('refuses approval from an unauthenticated caller', async () => {
    const { requestId } = await startLink();
    const res = await app.request(`/api/devices/link/${requestId}/approve`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('refuses to claim an unknown request', async () => {
    const res = await app.request('/api/devices/link/00000000-0000-4000-8000-000000000000/claim', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});

describe('device token', () => {
  it('rejects a made-up device token', async () => {
    const res = await app.request(
      '/api/devices/portal-snapshot',
      json(
        {
          portalId: 'veracross',
          origin: 'https://portals.veracross.com',
          redacted: true,
          capturedAt: new Date().toISOString(),
          map: {},
        },
        'not-a-token',
      ),
    );
    expect(res.status).toBe(401);
  });

  it('is not accepted where a browser session is expected', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    // A device token must not act as a session -- it should not list agents.
    const res = await app.request('/api/agents', as(device.token));
    expect(res.status).toBe(401);
  });

  it('stops working once revoked', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    await app.request(`/api/devices/${device.deviceId}/revoke`, json({}, alice.token));
    const res = await app.request(
      '/api/devices/portal-snapshot',
      json(
        {
          portalId: 'veracross',
          origin: 'https://portals.veracross.com',
          redacted: true,
          capturedAt: new Date().toISOString(),
          map: {},
        },
        device.token,
      ),
    );
    expect(res.status).toBe(401);
  });
});

describe('cross-user isolation', () => {
  it("does not let one student revoke another student's device", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const device = await linkDevice(alice.token);

    await app.request(`/api/devices/${device.deviceId}/revoke`, json({}, bob.token));

    // Bob's revoke must not have taken effect.
    const res = await app.request(
      '/api/devices/portal-snapshot',
      json(
        {
          portalId: 'veracross',
          origin: 'https://portals.veracross.com',
          redacted: true,
          capturedAt: new Date().toISOString(),
          map: {},
        },
        device.token,
      ),
    );
    expect(res.status).toBe(200);
  });

  it("does not list another student's devices", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await linkDevice(alice.token, 'Alice Laptop');

    const res = await app.request('/api/devices', as(bob.token));
    expect(await res.json()).toEqual([]);
  });

  it('stores a snapshot against the owning student only', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const device = await linkDevice(alice.token);

    await app.request(
      '/api/devices/portal-snapshot',
      json(
        {
          portalId: 'veracross',
          origin: 'https://portals.veracross.com',
          redacted: true,
          capturedAt: new Date().toISOString(),
          map: { pages: [{ url: 'x', title: 'Alice grades' }] },
        },
        device.token,
      ),
    );

    const res = await app.request('/api/devices', as(bob.token));
    expect(JSON.stringify(await res.json())).not.toContain('Alice');
  });
});

describe('snapshot retention', () => {
  const push = (token: string, portalId: string, day: number) =>
    app.request(
      '/api/devices/portal-snapshot',
      json(
        {
          portalId,
          origin: 'https://portals.veracross.com',
          redacted: false,
          capturedAt: new Date(Date.UTC(2026, 8, day)).toISOString(),
          map: { day },
        },
        token,
      ),
    );

  const rowsFor = (userId: string, portalId: string) =>
    db
      .select({ map: portalSnapshots.map, capturedAt: portalSnapshots.capturedAt })
      .from(portalSnapshots)
      .where(and(eq(portalSnapshots.userId, userId), eq(portalSnapshots.portalId, portalId)))
      .orderBy(desc(portalSnapshots.capturedAt));

  it('keeps only the newest few, and the newest is among them', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    for (let day = 1; day <= 8; day += 1) await push(device.token, 'veracross', day);

    const rows = await rowsFor(alice.id, 'veracross');
    expect(rows).toHaveLength(5);
    // Newest kept, oldest gone -- the failure mode is pruning the wrong end.
    expect((rows[0]?.map as { day: number }).day).toBe(8);
    expect(rows.map((r) => (r.map as { day: number }).day)).toEqual([8, 7, 6, 5, 4]);
  });

  it('does not prune a different portal belonging to the same student', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    await push(device.token, 'mozaik', 1);
    for (let day = 1; day <= 8; day += 1) await push(device.token, 'veracross', day);

    expect(await rowsFor(alice.id, 'mozaik')).toHaveLength(1);
  });

  it("does not prune another student's snapshots", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const aliceDevice = await linkDevice(alice.token);
    const bobDevice = await linkDevice(bob.token);

    await push(bobDevice.token, 'veracross', 1);
    for (let day = 1; day <= 8; day += 1) await push(aliceDevice.token, 'veracross', day);

    expect(await rowsFor(bob.id, 'veracross')).toHaveLength(1);
  });
});

describe('snapshot size', () => {
  it('refuses a snapshot too large to store', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    // The device runs on a machine we do not control, so this bound has to
    // hold against a runaway crawl, not just an honest large portal.
    const huge = { pages: [{ url: 'x', title: 'x', blob: 'y'.repeat(9 * 1024 * 1024) }] };
    const res = await app.request(
      '/api/devices/portal-snapshot',
      json(
        {
          portalId: 'veracross',
          origin: 'https://portals.veracross.com',
          redacted: false,
          capturedAt: new Date().toISOString(),
          map: huge,
        },
        device.token,
      ),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('accepts a large but realistic portal', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    const realistic = {
      pages: Array.from({ length: 40 }, (_, i) => ({
        url: `p${i}`,
        title: `Page ${i}`,
        components: [
          {
            shape: { rows: Array.from({ length: 50 }, (_, r) => ({ id: r, title: 'Assignment' })) },
          },
        ],
      })),
    };
    const res = await app.request(
      '/api/devices/portal-snapshot',
      json(
        {
          portalId: 'veracross',
          origin: 'https://portals.veracross.com',
          redacted: false,
          capturedAt: new Date().toISOString(),
          map: realistic,
        },
        device.token,
      ),
    );
    expect(res.status).toBe(200);
  });
});

describe('the unauthenticated link endpoint', () => {
  it('stops answering after too many attempts from one caller', async () => {
    // It writes a row per call and needs no credentials, so without a ceiling
    // anyone could fill the table.
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await app.request('/api/devices/link/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ deviceName: 'Spam' }),
      });
      codes.push(res.status);
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  });

  it('does not punish a different caller', async () => {
    for (let i = 0; i < 10; i += 1) {
      await app.request('/api/devices/link/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ deviceName: 'Spam' }),
      });
    }
    const other = await app.request('/api/devices/link/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.4' },
      body: JSON.stringify({ deviceName: 'Honest laptop' }),
    });
    expect(other.status).toBe(200);
  });

  it('sweeps expired requests, which nothing else deletes', async () => {
    await db.insert(deviceLinkRequests).values({
      deviceName: 'Long gone',
      expiresAt: new Date(Date.now() - 60_000),
    });
    await startLink();
    const left = await db.select({ name: deviceLinkRequests.deviceName }).from(deviceLinkRequests);
    expect(left.map((r) => r.name)).not.toContain('Long gone');
  });
});

describe('the session handed to a linked app', () => {
  it('works as a signed-in session, so the app does not ask again', async () => {
    const alice = await createUser();
    const { requestId } = await startLink();
    await app.request(`/api/devices/link/${requestId}/approve`, json({}, alice.token));
    const claimed = (await (
      await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' })
    ).json()) as { sessionToken: string };

    expect(claimed.sessionToken).toEqual(expect.any(String));
    // A route that needs a browser session, reached with it.
    const res = await app.request('/api/agents', as(claimed.sessionToken));
    expect(res.status).toBe(200);
  });

  it('is a different credential from the device token', async () => {
    const alice = await createUser();
    const { requestId } = await startLink();
    await app.request(`/api/devices/link/${requestId}/approve`, json({}, alice.token));
    const claimed = (await (
      await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' })
    ).json()) as { token: string; sessionToken: string };

    expect(claimed.token).not.toBe(claimed.sessionToken);
    // The device token still must not act as a session.
    expect((await app.request('/api/agents', as(claimed.token))).status).toBe(401);
  });

  it('belongs to the student who approved it', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { requestId } = await startLink();
    await app.request(`/api/devices/link/${requestId}/approve`, json({}, bob.token));
    const claimed = (await (
      await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' })
    ).json()) as { sessionToken: string };

    const devices = (await (
      await app.request('/api/devices', as(claimed.sessionToken))
    ).json()) as { name: string }[];
    // Bob approved it, so the session is Bob's and lists Bob's devices.
    expect(devices).toHaveLength(1);
    const alicesDevices = (await (
      await app.request('/api/devices', as(alice.token))
    ).json()) as unknown[];
    expect(alicesDevices).toHaveLength(0);
  });
});

describe('refreshing a session from a device', () => {
  it('gives a linked device a usable session without re-linking', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    const res = await app.request('/api/devices/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${device.token}` },
    });
    const { sessionToken } = (await res.json()) as { sessionToken: string };
    expect((await app.request('/api/agents', as(sessionToken))).status).toBe(200);
  });

  it('stops working the moment the device is revoked', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    await app.request(`/api/devices/${device.deviceId}/revoke`, json({}, alice.token));
    const res = await app.request('/api/devices/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(res.status).toBe(401);
  });

  it('refuses a made-up device token', async () => {
    const res = await app.request('/api/devices/session', {
      method: 'POST',
      headers: { Authorization: 'Bearer nonsense' },
    });
    expect(res.status).toBe(401);
  });
});

describe('linking the same machine again', () => {
  it('replaces the old row instead of adding a second', async () => {
    // Re-linking used to leave two rows with the same computer name, one of
    // which could never sync because its token existed nowhere, and no way to
    // tell them apart in Settings.
    const alice = await createUser();
    await linkDevice(alice.token, 'Lucass-MacBook-Air.local');
    await linkDevice(alice.token, 'Lucass-MacBook-Air.local');

    const listed = (await (await app.request('/api/devices', as(alice.token))).json()) as unknown[];
    expect(listed).toHaveLength(1);
  });

  it('leaves the newest one working', async () => {
    const alice = await createUser();
    await linkDevice(alice.token, 'Mac');
    const second = await linkDevice(alice.token, 'Mac');

    const res = await app.request(
      '/api/devices/portal-snapshot',
      json(
        {
          portalId: 'veracross',
          origin: 'https://portals.veracross.com',
          redacted: true,
          capturedAt: new Date().toISOString(),
          map: {},
        },
        second.token,
      ),
    );
    expect(res.status).toBe(200);
  });

  it('stops the superseded one working', async () => {
    const alice = await createUser();
    const first = await linkDevice(alice.token, 'Mac');
    await linkDevice(alice.token, 'Mac');

    const res = await app.request(
      '/api/devices/portal-snapshot',
      json(
        {
          portalId: 'veracross',
          origin: 'https://portals.veracross.com',
          redacted: true,
          capturedAt: new Date().toISOString(),
          map: {},
        },
        first.token,
      ),
    );
    expect(res.status).toBe(401);
  });

  it('does not touch a genuinely different computer', async () => {
    const alice = await createUser();
    await linkDevice(alice.token, 'MacBook');
    await linkDevice(alice.token, 'iMac');
    const listed = (await (await app.request('/api/devices', as(alice.token))).json()) as unknown[];
    expect(listed).toHaveLength(2);
  });

  it("does not touch another student's identically named machine", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await linkDevice(bob.token, 'Mac');
    await linkDevice(alice.token, 'Mac');

    const bobs = (await (await app.request('/api/devices', as(bob.token))).json()) as unknown[];
    expect(bobs).toHaveLength(1);
  });
});

describe('site icons', () => {
  const picture = (status: number) =>
    new Response('png-bytes', { status, headers: { 'content-type': 'image/png' } });

  it('refuses anything that is not a hostname', async () => {
    const alice = await createUser();
    const res = await app.request('/api/devices/sites/icon?host=not%20a%20host', as(alice.token));
    expect(res.status).toBe(400);
  });

  /**
   * The lookup answers an unknown site with a placeholder picture and a 404.
   * An <img> shows the picture regardless of the status, which is the whole
   * reason this route exists: here the status is read, and nothing goes back.
   */
  it('sends nothing back for a site the lookup does not know', async () => {
    const alice = await createUser();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(picture(404));
    try {
      const res = await app.request(
        '/api/devices/sites/icon?host=nowhere.example',
        as(alice.token),
      );
      expect(res.status).toBe(404);
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('serves the icon with its type, and lets the browser keep it a while', async () => {
    const alice = await createUser();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(picture(200));
    try {
      const res = await app.request(
        '/api/devices/sites/icon?host=portals.veracross.com',
        as(alice.token),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toContain('max-age');
      expect(await res.text()).toBe('png-bytes');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('browser attempts', () => {
  const attempt = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    kind: 'browse',
    requestId: null,
    portalId: null,
    target: 'https://a.test/',
    startedAt: '2026-10-09T12:00:00.000Z',
    endedAt: '2026-10-09T12:00:02.000Z',
    outcome: 'failed',
    code: 'nav.dns',
    message: 'That address does not exist.',
    steps: [{ t: 0, name: 'navigate', detail: { url: 'https://a.test/' } }],
    ...overrides,
  });

  it('stores an attempt against the device’s own student, once', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    const body = attempt();
    expect((await app.request('/api/devices/attempts', json(body, device.token))).status).toBe(200);
    expect((await app.request('/api/devices/attempts', json(body, device.token))).status).toBe(200);

    const rows = await db.select().from(browserAttempts).where(eq(browserAttempts.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: alice.id, deviceId: device.deviceId, code: 'nav.dns' });
  });

  it('drops a request id that belongs to another student', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const [bobsRequest] = await db
      .insert(siteRefreshRequests)
      .values({ userId: bob.id, portalId: 'x' })
      .returning({ id: siteRefreshRequests.id });
    const device = await linkDevice(alice.token);
    const body = attempt({ requestId: bobsRequest!.id });
    await app.request('/api/devices/attempts', json(body, device.token));
    const [row] = await db.select().from(browserAttempts).where(eq(browserAttempts.id, body.id));
    expect(row!.requestId).toBeNull();
  });

  it('refuses an attempt too large to keep', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    const body = attempt({ screenshot: 'data:image/jpeg;base64,' + 'A'.repeat(3 * 1024 * 1024) });
    const res = await app.request('/api/devices/attempts', json(body, device.token));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses an attempt from no device', async () => {
    const res = await app.request('/api/devices/attempts', json(attempt()));
    expect(res.status).toBe(401);
  });

  it('marks work as picked up when a device collects it', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    const [request] = await db
      .insert(siteRefreshRequests)
      .values({ userId: alice.id, portalId: 'kognity' })
      .returning({ id: siteRefreshRequests.id });
    await app.request('/api/devices/pending', as(device.token));
    const [row] = await db
      .select({ pickedUpAt: siteRefreshRequests.pickedUpAt })
      .from(siteRefreshRequests)
      .where(eq(siteRefreshRequests.id, request!.id));
    expect(row!.pickedUpAt).toBeInstanceOf(Date);
  });

  it('records what the device says it is busy with', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    const busy = { kind: 'sync', portalId: 'kognity', since: '2026-10-09T12:00:00.000Z' };
    const res = await app.request('/api/devices/heartbeat', json({ busy }, device.token));
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ state: devices.state, stateAt: devices.stateAt })
      .from(devices)
      .where(eq(devices.id, device.deviceId));
    expect(row!.state).toEqual({ busy });
    expect(row!.stateAt).toBeInstanceOf(Date);
  });
});
