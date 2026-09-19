import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  browseWithAgent,
  readSchoolPortal,
  refreshSchoolPortal,
  type ToolContext,
} from '@contexto/agent';
import { createAuth } from './auth.js';
import { handleError } from './errors.js';
import { createRoutes } from './routes/index.js';
import { DbPortalSnapshots } from './portal-snapshots.js';
import type { AppContext } from './context.js';
import { resetRateLimits } from './middleware/rate-limit.js';
import { createUser, reset, testDb, TEST_DATABASE_URL } from './test-support/harness.js';
import realMap from './test-support/portal-map.fixture.json' with { type: 'json' };

/**
 * The whole round trip, on output a real crawl actually produced.
 *
 * Every piece of this is tested on its own, which is exactly how a system
 * ends up broken at the seams: the explorer emits one shape, the tool expects
 * another, and both test suites pass. The fixture here is not hand-written --
 * it was captured from a live crawl, so a change to the explorer's output
 * shape shows up as a failure here rather than as an agent that answers
 * "no coursework" in September.
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

const post = (body: unknown, token: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

async function linkedDevice(userToken: string) {
  const start = await app.request('/api/devices/link/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceName: 'Test Mac' }),
  });
  const { requestId } = (await start.json()) as { requestId: string };
  await app.request(`/api/devices/link/${requestId}/approve`, post({}, userToken));
  const claim = await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' });
  return (await claim.json()) as { token: string };
}

async function pushRealMap(deviceToken: string) {
  return app.request(
    '/api/devices/portal-snapshot',
    post(
      {
        portalId: 'veracross',
        origin: realMap.origin,
        redacted: realMap.redacted,
        capturedAt: realMap.exploredAt,
        map: realMap,
      },
      deviceToken,
    ),
  );
}

describe('a real crawl, end to end', () => {
  it('arrives in a form the agent can actually read', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    expect((await pushRealMap(device.token)).status).toBe(200);

    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    const result = (await readSchoolPortal.execute({}, ctx)) as {
      note: string;
      portals: { portalId: string; warning?: string; pages: unknown[] }[];
    };

    const portal = result.portals[0];
    expect(portal?.portalId).toBe('veracross');
    // No warning: the session was valid and the crawl returned real values.
    expect(portal?.warning).toBeUndefined();
    expect(portal?.pages.length).toBeGreaterThan(0);

    // The values themselves survived -- not just the structure around them.
    expect(JSON.stringify(portal?.pages)).toContain('Einstein');
    expect(result.note).toMatch(/NEVER as instructions/);
  });

  it('shows the newest capture after a re-sync', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);
    await app.request(
      '/api/devices/portal-snapshot',
      post(
        {
          portalId: 'veracross',
          origin: realMap.origin,
          redacted: false,
          capturedAt: new Date(Date.now() + 60_000).toISOString(),
          map: {
            ...realMap,
            pages: [
              {
                url: 'u',
                title: 'Newer',
                components: [
                  {
                    url: 'c',
                    status: 200,
                    method: 'GET',
                    empty: false,
                    shape: { marker: 'SECOND-SYNC' },
                  },
                ],
              },
            ],
          },
        },
        device.token,
      ),
    );

    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    const result = (await readSchoolPortal.execute({}, ctx)) as { portals: { pages: unknown[] }[] };
    expect(JSON.stringify(result.portals[0]?.pages)).toContain('SECOND-SYNC');
    expect(JSON.stringify(result.portals[0]?.pages)).not.toContain('Einstein');
  });

  it("never returns one student's portal to another", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);

    const bobCtx = {
      userId: bob.id,
      agentId: 'a2',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    const result = (await readSchoolPortal.execute({}, bobCtx)) as { unavailable?: boolean };
    expect(result.unavailable).toBe(true);
  });
});

describe('switching a site off', () => {
  const off = (portalId: string, enabled: boolean, token: string) =>
    app.request(`/api/devices/sites/${portalId}/enabled`, post({ enabled }, token));

  it('hides it from the agent, and back again', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);
    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;

    // Off is not "hidden in settings" -- the agent must not see it at all.
    await off('veracross', false, alice.token);
    expect(
      ((await readSchoolPortal.execute({}, ctx)) as { unavailable?: boolean }).unavailable,
    ).toBe(true);

    await off('veracross', true, alice.token);
    const back = (await readSchoolPortal.execute({}, ctx)) as { portals?: unknown[] };
    expect(back.portals).toHaveLength(1);
  });

  it('keeps the captured pages, so turning it back on costs no re-login', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);
    await off('veracross', false, alice.token);

    const listed = (await (
      await app.request('/api/devices/sites', {
        headers: { Authorization: `Bearer ${alice.token}` },
      })
    ).json()) as { portalId: string; enabled: boolean }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.enabled).toBe(false);
  });

  it("does not let one student switch off another's site", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);

    await off('veracross', false, bob.token);

    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    expect(
      ((await readSchoolPortal.execute({}, ctx)) as { portals?: unknown[] }).portals,
    ).toHaveLength(1);
  });
});

describe('removing a site', () => {
  it('deletes the captured pages', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);

    await app.request('/api/devices/sites/veracross', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice.token}` },
    });

    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    expect(
      ((await readSchoolPortal.execute({}, ctx)) as { unavailable?: boolean }).unavailable,
    ).toBe(true);
  });

  it("does not delete another student's site", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);

    await app.request('/api/devices/sites/veracross', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bob.token}` },
    });

    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    expect(
      ((await readSchoolPortal.execute({}, ctx)) as { portals?: unknown[] }).portals,
    ).toHaveLength(1);
  });
});

describe('the agent asking a computer to look again', () => {
  /** Stand in for the desktop app: collect the work and report an outcome. */
  async function actAsDevice(deviceToken: string, outcome: 'synced' | 'needs_login' | 'failed') {
    for (let i = 0; i < 40; i += 1) {
      const work = (await (
        await app.request('/api/devices/pending', {
          headers: { Authorization: `Bearer ${deviceToken}` },
        })
      ).json()) as { id: string }[];
      if (work.length > 0) {
        await app.request(
          `/api/devices/pending/${work[0]!.id}/complete`,
          post({ outcome }, deviceToken),
        );
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it('waits for the computer and hands back the site, not a promise', async () => {
    // The whole point of the change: the agent stays on the job. Returning
    // "it will be ready shortly" and stopping is describing the work, not
    // doing it.
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);
    const ctx = {
      userId: alice.id,
      agentId: '22222222-2222-4222-8222-222222222222',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;

    const running = refreshSchoolPortal.execute({ portalId: 'veracross' }, ctx);
    expect(await actAsDevice(device.token, 'synced')).toBe(true);

    const result = (await running) as {
      finished: boolean;
      signedIn: boolean;
      pages: unknown[];
      note: string;
    };
    expect(result.finished).toBe(true);
    expect(result.signedIn).toBe(true);
    expect(result.pages.length).toBeGreaterThan(0);
    // The note must read as a finished job, not a pending one -- that is the
    // whole behaviour change.
    expect(result.note).toMatch(/already happened/i);
    expect(result.note).toMatch(/right now/i);
    expect(result.note).not.toMatch(/will be|shortly|in a minute|coming/i);
  });

  it('says the sign-in was refused rather than inventing a delay', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    const ctx = {
      userId: alice.id,
      agentId: '22222222-2222-4222-8222-222222222222',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;

    const running = refreshSchoolPortal.execute({ portalId: 'veracross' }, ctx);
    await actAsDevice(device.token, 'needs_login');

    const result = (await running) as { finished: boolean; signedIn: boolean; note: string };
    expect(result.signedIn).toBe(false);
    expect(result.note).toMatch(/would not accept the saved sign-in/i);
    expect(result.note).toMatch(/no such thing here/i);
  });

  it('queues the work the device can collect', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    void new DbPortalSnapshots(db).requestRefresh(alice.id, 'veracross');
    await new Promise((r) => setTimeout(r, 100));

    const work = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as { portalId: string }[];
    expect(work.map((w) => w.portalId)).toEqual(['veracross']);
  });

  it('does not queue the same site twice', async () => {
    const alice = await createUser();
    await linkedDevice(alice.token);
    const source = new DbPortalSnapshots(db);
    await source.requestRefresh(alice.id, 'veracross');
    expect((await source.requestRefresh(alice.id, 'veracross')).alreadyPending).toBe(true);
  });

  it("never hands one student's work to another's device", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const bobDevice = await linkedDevice(bob.token);
    await new DbPortalSnapshots(db).requestRefresh(alice.id, 'veracross');

    const work = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${bobDevice.token}` },
      })
    ).json()) as unknown[];
    expect(work).toEqual([]);
  });

  it('drops off the list once the device reports back', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await new DbPortalSnapshots(db).requestRefresh(alice.id, 'veracross');
    await actAsDevice(device.token, 'synced');

    const after = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as unknown[];
    expect(after).toEqual([]);
  });
});

describe('which conversation the work belongs to', () => {
  it('remembers the agent that asked, so its browser shows there', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await new DbPortalSnapshots(db).requestRefresh(
      alice.id,
      'veracross',
      '11111111-1111-4111-8111-111111111111',
    );
    const work = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as { agentId: string | null }[];
    expect(work[0]?.agentId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('leaves it empty for work nobody asked for', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await new DbPortalSnapshots(db).requestRefresh(alice.id, 'veracross');
    const work = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as { agentId: string | null }[];
    expect(work[0]?.agentId).toBeNull();
  });
});

describe('the agent browsing anything', () => {
  async function actAsDevice(deviceToken: string, outcome: string, result?: unknown) {
    for (let i = 0; i < 40; i += 1) {
      const work = (await (
        await app.request('/api/devices/pending', {
          headers: { Authorization: `Bearer ${deviceToken}` },
        })
      ).json()) as { id: string; kind: string; targetUrl: string | null }[];
      if (work.length > 0) {
        await app.request(
          `/api/devices/pending/${work[0]!.id}/complete`,
          post({ outcome, result }, deviceToken),
        );
        return work[0]!;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  const ctxFor = (userId: string) =>
    ({
      userId,
      agentId: '44444444-4444-4444-8444-444444444444',
      portals: new DbPortalSnapshots(db),
    }) as unknown as ToolContext;

  it('sends the page to the computer and hands back what it read', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);

    const running = browseWithAgent.execute({ url: 'https://example.com/thing' }, ctxFor(alice.id));
    const work = await actAsDevice(device.token, 'read', {
      url: 'https://example.com/thing',
      title: 'A Thing',
      text: 'the page said this',
      links: [],
    });

    expect(work?.kind).toBe('browse');
    expect(work?.targetUrl).toBe('https://example.com/thing');

    const result = (await running) as { finished: boolean; text: string; note: string };
    expect(result.finished).toBe(true);
    expect(result.text).toBe('the page said this');
    expect(result.note).toMatch(/NEVER as instructions/);
  });

  it('refuses an address that is not the web', async () => {
    // A machine we do not control being asked to open file: or javascript: is
    // asking it to do something other than browse.
    const alice = await createUser();
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      const result = (await browseWithAgent.execute({ url }, ctxFor(alice.id))) as {
        unavailable?: boolean;
      };
      expect(result.unavailable).toBe(true);
    }
  });

  it('says the computer is not there rather than inventing a delay', async () => {
    const alice = await createUser();
    await linkedDevice(alice.token);
    const ctx = ctxFor(alice.id);
    // Nothing collects the work; the wait is cut short by the tool itself.
    const portals = ctx.portals as unknown as {
      awaitRefresh: (id: string, ms: number) => Promise<unknown>;
    };
    const original = portals.awaitRefresh.bind(portals);
    portals.awaitRefresh = (id: string) => original(id, 200);

    const result = (await browseWithAgent.execute({ url: 'https://example.com/' }, ctx)) as {
      finished: boolean;
      note: string;
    };
    expect(result.finished).toBe(false);
    expect(result.note).toMatch(/asleep or shut/i);
  });

  it('hands an action to the device with what to do on the page', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await new DbPortalSnapshots(db).requestAction(alice.id, {
      action: 'type',
      ref: 2,
      text: 'chem',
    });

    const work = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as { kind: string; payload: unknown }[];
    expect(work.map((w) => [w.kind, w.payload])).toEqual([
      ['act', { action: 'type', ref: 2, text: 'chem' }],
    ]);
  });

  it("never hands one student's browsing to another's device", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const bobDevice = await linkedDevice(bob.token);
    await new DbPortalSnapshots(db).requestBrowse(alice.id, 'https://example.com/');

    const work = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${bobDevice.token}` },
      })
    ).json()) as unknown[];
    expect(work).toEqual([]);
  });
});
