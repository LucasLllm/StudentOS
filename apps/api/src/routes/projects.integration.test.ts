import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { Vault, projectVault } from '@contexto/agent';
import { agents, projects } from '@contexto/db';
import { createAuth } from '../auth.js';
import { handleError } from '../errors.js';
import { createRoutes } from './index.js';
import type { AppContext } from '../context.js';
import { createUser, reset, testDb, TEST_DATABASE_URL } from '../test-support/harness.js';

/**
 * Projects, over the real routes and the real database.
 *
 * The one that matters most is the first: a project is somebody's work and
 * the context in it came out of their mail and their Drive, so every route has
 * to be a 404 to anybody else.
 */

let app: Hono;
let vaultRoot: string;

const model = {
  chat: async () => ({
    content: 'A one-line summary.',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 },
    finishReason: 'stop' as const,
  }),
};

beforeAll(async () => {
  const db = await testDb();
  vaultRoot = mkdtempSync(join(tmpdir(), 'contexto-projects-'));
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
    VAULT_ROOT: vaultRoot,
  };
  const ctx = {
    env,
    db,
    auth: createAuth(db, env as never),
    llm: { ...model, resolve: async () => model },
  } as unknown as AppContext;
  app = new Hono().route('/api', createRoutes(ctx)).onError(handleError);
});

afterAll(() => rmSync(vaultRoot, { recursive: true, force: true }));
beforeEach(reset);

const as = (token: string, init: RequestInit = {}) => ({
  ...init,
  headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
});

async function createProject(token: string, name = 'CAS proposal') {
  const res = await app.request(
    '/api/projects',
    as(token, { method: 'POST', body: JSON.stringify({ name, instructions: 'Get it approved.' }) }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { project: { id: string; name: string } }).project;
}

describe('projects', () => {
  it('are created, listed, renamed and deleted by their owner', async () => {
    const alice = await createUser();
    const project = await createProject(alice.token);

    const list = (await (await app.request('/api/projects', as(alice.token))).json()) as {
      projects: { id: string }[];
    };
    expect(list.projects.map((p) => p.id)).toEqual([project.id]);

    const renamed = await app.request(
      `/api/projects/${project.id}`,
      as(alice.token, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) }),
    );
    expect(((await renamed.json()) as { project: { name: string } }).project.name).toBe('Renamed');

    const gone = await app.request(
      `/api/projects/${project.id}`,
      as(alice.token, { method: 'DELETE' }),
    );
    expect(gone.status).toBe(204);
    expect((await app.request(`/api/projects/${project.id}`, as(alice.token))).status).toBe(404);
  });

  it('are a 404 to anybody else, on every route', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const project = await createProject(alice.token);

    for (const [path, method] of [
      [`/api/projects/${project.id}`, 'GET'],
      [`/api/projects/${project.id}`, 'DELETE'],
      [`/api/projects/${project.id}/chats`, 'GET'],
      [`/api/projects/${project.id}/sources`, 'GET'],
    ] as const) {
      const res = await app.request(path, as(bob.token, { method }));
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    const text = await app.request(
      `/api/projects/${project.id}/sources/text`,
      as(bob.token, { method: 'POST', body: JSON.stringify({ title: 'x', body: 'y' }) }),
    );
    expect(text.status).toBe(404);
    const listed = (await (await app.request('/api/projects', as(bob.token))).json()) as {
      projects: unknown[];
    };
    expect(listed.projects).toHaveLength(0);
  });
});

describe('chats in a project', () => {
  it('are started only in a project of your own', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const project = await createProject(alice.token);

    const res = await app.request(
      '/api/agents',
      as(bob.token, { method: 'POST', body: JSON.stringify({ name: 'x', projectId: project.id }) }),
    );
    expect(res.status).toBe(404);
  });

  it('are listed on the project and kept out of the rail', async () => {
    const alice = await createUser();
    const project = await createProject(alice.token);
    await app.request(
      '/api/agents',
      as(alice.token, {
        method: 'POST',
        body: JSON.stringify({ name: 'In project', projectId: project.id }),
      }),
    );
    await app.request(
      '/api/agents',
      as(alice.token, { method: 'POST', body: JSON.stringify({ name: 'Ordinary' }) }),
    );

    const rail = (await (await app.request('/api/agents', as(alice.token))).json()) as {
      agents: { name: string }[];
    };
    expect(rail.agents.map((a) => a.name)).toEqual(['Ordinary']);

    const chats = (await (
      await app.request(`/api/projects/${project.id}/chats`, as(alice.token))
    ).json()) as { chats: { name: string }[] };
    expect(chats.chats.map((c) => c.name)).toEqual(['In project']);
  });

  it('go when the project goes', async () => {
    const alice = await createUser();
    const project = await createProject(alice.token);
    await app.request(
      '/api/agents',
      as(alice.token, {
        method: 'POST',
        body: JSON.stringify({ name: 'In project', projectId: project.id }),
      }),
    );
    await app.request(`/api/projects/${project.id}`, as(alice.token, { method: 'DELETE' }));
    const db = await testDb();
    const left = await db.select().from(agents).where(eq(agents.userId, alice.id));
    expect(left).toHaveLength(0);
  });
});

describe('context', () => {
  it('takes pasted text, lists it with its summary, and gives it back whole', async () => {
    const alice = await createUser();
    const project = await createProject(alice.token);

    const added = await app.request(
      `/api/projects/${project.id}/sources/text`,
      as(alice.token, {
        method: 'POST',
        body: JSON.stringify({ title: 'Idea summary', body: 'An incubator for student startups.' }),
      }),
    );
    expect(added.status).toBe(201);

    const list = (await (
      await app.request(`/api/projects/${project.id}/sources`, as(alice.token))
    ).json()) as {
      sources: { id: string; name: string; kind: string; summary: string; preview: string }[];
    };
    expect(list.sources).toHaveLength(1);
    expect(list.sources[0]).toMatchObject({
      name: 'idea-summary',
      kind: 'text',
      summary: 'A one-line summary.',
      preview: 'An incubator for student startups.',
    });

    const one = (await (
      await app.request(
        `/api/projects/${project.id}/sources/${list.sources[0]!.id}`,
        as(alice.token),
      )
    ).json()) as { body: string };
    expect(one.body).toBe('An incubator for student startups.');
  });

  it("keeps what it owns out of the student's own vault", async () => {
    const alice = await createUser();
    const project = await createProject(alice.token);
    await app.request(
      `/api/projects/${project.id}/sources/text`,
      as(alice.token, {
        method: 'POST',
        body: JSON.stringify({ title: 'Secret plan', body: 'x' }),
      }),
    );

    expect(await new Vault(vaultRoot, alice.id).read('entity', 'secret-plan')).toBeNull();
    expect(
      await projectVault(vaultRoot, alice.id, project.id).read('entity', 'secret-plan'),
    ).not.toBeNull();
  });

  it('removes an owned item with its note, and the project with its vault', async () => {
    const alice = await createUser();
    const project = await createProject(alice.token);
    await app.request(
      `/api/projects/${project.id}/sources/text`,
      as(alice.token, { method: 'POST', body: JSON.stringify({ title: 'Draft', body: 'x' }) }),
    );
    const list = (await (
      await app.request(`/api/projects/${project.id}/sources`, as(alice.token))
    ).json()) as { sources: { id: string }[] };

    const removed = await app.request(
      `/api/projects/${project.id}/sources/${list.sources[0]!.id}`,
      as(alice.token, { method: 'DELETE' }),
    );
    expect(removed.status).toBe(204);
    const vault = projectVault(vaultRoot, alice.id, project.id);
    expect(await vault.read('entity', 'draft')).toBeNull();

    await app.request(`/api/projects/${project.id}`, as(alice.token, { method: 'DELETE' }));
    expect(existsSync(vault.directory)).toBe(false);
    const db = await testDb();
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(0);
  });

  it('takes an upload into the project', async () => {
    const alice = await createUser();
    const project = await createProject(alice.token);
    const form = new FormData();
    form.append(
      'file',
      new File(['Rubric: clarity, evidence.'], 'Rubric.txt', { type: 'text/plain' }),
    );
    const res = await app.request(`/api/projects/${project.id}/sources/upload`, {
      method: 'POST',
      body: form,
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: 'rubric',
      filename: 'Rubric.txt',
      image: false,
    });
  });

  it('keeps two notes with the same title as two items', async () => {
    const alice = await createUser();
    const project = await createProject(alice.token);
    for (const body of ['First.', 'Second.']) {
      await app.request(
        `/api/projects/${project.id}/sources/text`,
        as(alice.token, { method: 'POST', body: JSON.stringify({ title: 'Feedback', body }) }),
      );
    }
    const list = (await (
      await app.request(`/api/projects/${project.id}/sources`, as(alice.token))
    ).json()) as { sources: { name: string; preview: string }[] };
    expect(list.sources.map((s) => s.preview).sort()).toEqual(['First.', 'Second.']);
    expect(new Set(list.sources.map((s) => s.name)).size).toBe(2);
  });

  it('writes nothing for a project that has gone', async () => {
    const alice = await createUser();
    const project = await createProject(alice.token);
    await app.request(`/api/projects/${project.id}`, as(alice.token, { method: 'DELETE' }));
    const res = await app.request(
      `/api/projects/${project.id}/sources/text`,
      as(alice.token, { method: 'POST', body: JSON.stringify({ title: 'Late', body: 'x' }) }),
    );
    expect(res.status).toBe(404);
    expect(existsSync(projectVault(vaultRoot, alice.id, project.id).directory)).toBe(false);
  });
});
