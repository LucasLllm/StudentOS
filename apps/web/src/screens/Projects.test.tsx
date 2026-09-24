// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Projects } from './Projects.js';

/**
 * The projects list: that it shows what the server has, finds one by name,
 * and that New makes a project and goes to it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let requests: { url: string; method: string; body?: string }[];

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

const project = (id: string, name: string) => ({
  id,
  name,
  instructions: '',
  gathering: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

function serve(projects: ReturnType<typeof project>[]) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
    const body = input instanceof Request ? await input.clone().text() : (init?.body as string);
    requests.push({ url, method, ...(body ? { body } : {}) });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'POST') return json({ project: project('new-id', 'Made') }, 201);
    return json({ projects });
  });
}

beforeEach(() => {
  requests = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const names = () =>
  [...container.querySelectorAll('.projects-name')].map((el) => el.textContent ?? '');

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the projects list', () => {
  it('lists projects and filters them by name', async () => {
    serve([project('p1', 'CAS proposal'), project('p2', 'Recommendation letter')]);
    await act(async () => root.render(<Projects />));
    await settle();
    expect(names()).toEqual(['CAS proposal', 'Recommendation letter']);
    expect(container.querySelector('.projects-modified.muted')?.textContent).toBe('Today');

    await type(container.querySelector('.projects-search input') as HTMLInputElement, 'letter');
    expect(names()).toEqual(['Recommendation letter']);
  });

  it('offers to make one when there are none', async () => {
    serve([]);
    await act(async () => root.render(<Projects />));
    await settle();
    expect(container.querySelector('.projects-empty')).not.toBeNull();
  });

  it('makes a project with its goal and opens it', async () => {
    serve([]);
    await act(async () => root.render(<Projects />));
    await settle();

    await act(async () =>
      (container.querySelector('.projects-tools .primary') as HTMLButtonElement).click(),
    );
    const dialog = document.querySelector('.project-dialog') as HTMLFormElement;
    await type(dialog.querySelector('input') as HTMLInputElement, 'History IA');
    await type(dialog.querySelector('textarea') as HTMLTextAreaElement, 'A 2,200 word essay.');
    await act(async () => dialog.requestSubmit());
    await settle();

    const post = requests.find((request) => request.method === 'POST');
    expect(post?.url).toContain('/api/projects');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({
      name: 'History IA',
      instructions: 'A 2,200 word essay.',
    });
    expect(window.location.pathname).toBe('/projects/new-id');
  });
});
