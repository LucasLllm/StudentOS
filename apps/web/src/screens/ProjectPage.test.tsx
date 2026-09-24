// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { takeHandoff } from '../lib/handoff.js';

/**
 * A project's page: its chats, its context, starting a chat in it, and the
 * menu that renames and deletes it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let requests: { url: string; method: string; body?: string }[];

const now = new Date().toISOString();
const project = {
  id: 'p1',
  name: 'CAS proposal',
  instructions: 'Get it approved.',
  gathering: false,
  createdAt: now,
  updatedAt: now,
};

const sources = [
  {
    id: 's1',
    name: 'idea-summary',
    kind: 'text',
    summary: 'The idea in brief',
    preview: 'An incubator for student startups.',
    image: false,
    addedAt: now,
  },
  {
    id: 's2',
    name: 'mail-feedback',
    kind: 'email',
    summary: 'Feedback from the coordinator',
    preview: 'Looks good.',
    image: false,
    addedAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  requests = [];
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
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/api/agents') && method === 'POST') {
      return json({ agent: { id: 'a-new', name: 'x' } }, 201);
    }
    if (url.endsWith('/chats')) {
      return json({
        chats: [
          { id: 'c1', name: 'Resume writeup', preview: 'Make it point form', updatedAt: now },
        ],
      });
    }
    if (url.endsWith('/sources')) return json({ sources });
    return json({ project });
  });
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

async function show() {
  await act(async () => root.render(<ProjectPage projectId="p1" />));
  await settle();
}

const texts = (selector: string) =>
  [...document.querySelectorAll(selector)].map((el) => el.textContent ?? '');

describe('a project page', () => {
  it('shows its name, a composer that says where the chat goes, and its chats', async () => {
    await show();
    expect(container.querySelector('.project-title h1')?.textContent).toBe('CAS proposal');
    expect(container.querySelector('textarea')?.getAttribute('placeholder')).toBe(
      'New chat in CAS proposal',
    );
    expect(texts('.project-chat-name')).toEqual(['Resume writeup']);
    expect(texts('.project-chat-preview')).toEqual(['Make it point form']);
  });

  it('starts a chat inside the project', async () => {
    await show();
    const input = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, 'Draft the budget section');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (input.form as HTMLFormElement).requestSubmit());
    await settle();

    const post = requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/agents'));
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({ projectId: 'p1' });
    expect(takeHandoff('a-new')?.content).toBe('Draft the budget section');
    expect(window.location.pathname).toBe('/chats/a-new');
  });

  it('shows the context as pages, filters it, and takes an item out', async () => {
    await show();
    const tab = [...container.querySelectorAll('.project-tabs button')].find(
      (b) => b.textContent === 'Context',
    ) as HTMLButtonElement;
    await act(async () => tab.click());
    await settle();

    expect(texts('.context-name')).toEqual(['Idea summary', 'Mail feedback']);
    expect(texts('.context-page-text')[0]).toBe('An incubator for student startups.');
    // No item says who put it there.
    expect(container.querySelector('.context-card')?.textContent).not.toMatch(/agent|you added/i);

    const kind = container.querySelector('select[aria-label="Show"]') as HTMLSelectElement;
    await act(async () => {
      kind.value = 'email';
      kind.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(texts('.context-name')).toEqual(['Mail feedback']);

    await act(async () =>
      (container.querySelector('.context-remove') as HTMLButtonElement).click(),
    );
    await settle();
    expect(requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/sources/s2'))).toBe(true);
    expect(texts('.context-name')).toEqual([]);
  });

  it('asks before deleting the project, then goes back to the list', async () => {
    await show();
    await act(async () => (container.querySelector('.project-more') as HTMLButtonElement).click());
    const del = [...container.querySelectorAll('.chat-menu button')].find(
      (b) => b.textContent === 'Delete project',
    ) as HTMLButtonElement;
    await act(async () => del.click());
    expect(document.querySelector('#confirm-delete-title')?.textContent).toBe(
      'Delete this project?',
    );
    await act(async () => (document.querySelector('.dialog .danger') as HTMLButtonElement).click());
    await settle();
    expect(requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/api/projects/p1'))).toBe(
      true,
    );
    expect(window.location.pathname).toBe('/projects');
  });
});
