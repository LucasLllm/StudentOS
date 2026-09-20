// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleConnections } from './GoogleConnections.js';

/**
 * The round trip to Google, from this side of it.
 *
 * Google itself is not here. What is covered is what the screen sends along
 * with the student -- where to bring them back to -- and what it does with
 * them when they arrive: reads Google's answer off the address, and does not
 * stay saying "Opening…" when the browser's Back button restores the page
 * exactly as they left it.
 */

// React needs telling that this is a test, or every act() warns and the
// updates it is supposed to flush are left in flight.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/*
 * Installed before the imports above run, because the auth client takes hold
 * of `fetch` the moment its module loads. A stub put in place by beforeEach
 * would reach the API client and miss the request that matters here.
 */
const network = vi.hoisted(() => {
  const state: { handler: Fetch | null } = { handler: null };
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (!state.handler) throw new Error('no network handler for this test');
    return state.handler(input, init);
  });
  return state;
});

let container: HTMLDivElement;
let root: Root;
/** The body of the last request that would have sent the student to Google. */
let linkRequest: Record<string, unknown> | null;

/** Let the component's in-flight fetches settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  linkRequest = null;
  network.handler = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/google/status')) {
      return json({
        classroom: false,
        drive: false,
        gmail: false,
        disabled: [],
        missing: { classroom: [], gmail: [] },
      });
    }
    if (url.includes('/api/google/connect-scopes/')) return json({ scopes: ['openid'] });
    if (url.endsWith('/api/auth/link-social')) {
      const raw = init?.body ?? (input instanceof Request ? await input.text() : '');
      linkRequest = JSON.parse(String(raw)) as Record<string, unknown>;
      // Deferred rather than followed: a test has nowhere to go.
      return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth', redirect: false });
    }
    return new Response('', { status: 404 });
  };

  window.history.replaceState({}, '', '/settings?section=connections');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  network.handler = null;
});

async function show() {
  await act(async () => {
    root.render(<GoogleConnections />);
  });
  await settle();
}

const connectAll = () => container.querySelector<HTMLButtonElement>('.connect-all button');

async function pressConnectAll() {
  await act(async () => {
    connectAll()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('leaving for Google', () => {
  it('asks to be brought back to Settings, open on Connections, whether Google says yes or no', async () => {
    // Settings is a window over a chat, so this is the address underneath it.
    window.history.replaceState({}, '', '/chats/abc');
    await show();
    await pressConnectAll();

    const here = `${window.location.origin}/settings?section=connections`;
    expect(linkRequest?.['callbackURL']).toBe(here);
    expect(linkRequest?.['errorCallbackURL']).toBe(here);
  });
});

describe('coming back from Google', () => {
  it("shows Google's no, and takes it off the address so a refresh does not repeat it", async () => {
    window.history.replaceState({}, '', '/settings?section=connections&error=access_denied');
    await show();

    expect(container.textContent).toContain(
      "Nothing was connected: Google's permission screen was closed before the end.",
    );
    expect(window.location.search).not.toContain('error');
  });

  it('is not left saying Opening… when Back restores the page as it was', async () => {
    await show();
    await pressConnectAll();
    expect(connectAll()?.textContent).toBe('Opening…');

    // The browser brought the page back from its cache, state and all.
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });

    expect(connectAll()?.textContent).toBe('Connect');
    expect(connectAll()?.disabled).toBe(false);
  });
});
