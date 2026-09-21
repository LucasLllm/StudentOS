// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSession } from './AgentSession.js';
import type { DesktopBridge } from '../lib/desktop.js';

/**
 * The card shows what the agent is looking at.
 *
 * Collapsed, it used to be a placeholder with "Click to open" on it; now it
 * carries a still of the page, sent by the app after every step and asked
 * for on mount. What is pinned: the still from the app's reply is shown, a
 * later one from the event replaces it, and one from another conversation
 * is left alone.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHAT = 'a1';
const OTHER = 'a2';
const FIRST = 'data:image/jpeg;base64,AAAA';
const SECOND = 'data:image/jpeg;base64,BBBB';

type FrameListener = Parameters<NonNullable<DesktopBridge['onSiteFrame']>>[0];

/** A desktop bridge reporting a browser on screen for this chat, with a still. */
function stubBridge(frame: string | null) {
  const listeners: FrameListener[] = [];
  const bridge = {
    version: 1,
    listSites: async () => [],
    addSite: async () => ({ ok: true }),
    removeSite: async () => ({ ok: true }),
    beginLogin: async () => ({ ok: true }),
    finishLogin: async () => ({ ok: true }),
    syncSite: async () => ({ ok: true }),
    onSitesChanged: () => {},
    setSiteViewBounds: async () => ({}),
    getSiteSession: async () => ({
      ok: true,
      value: { active: true, showing: true, portalId: 'studyo', agentId: CHAT, frame },
    }),
    onSiteSession: () => () => {},
    onSiteFrame: (fn: FrameListener) => {
      listeners.push(fn);
      return () => {};
    },
  } as unknown as DesktopBridge;
  (window as unknown as { contextoDesktop?: DesktopBridge }).contextoDesktop = bridge;
  return { send: (payload: Parameters<FrameListener>[0]) => listeners.forEach((l) => l(payload)) };
}

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { contextoDesktop?: DesktopBridge }).contextoDesktop;
});

const still = () => container.querySelector<HTMLImageElement>('img.agent-browser-still');

describe('the browser card', () => {
  it('shows the still the app already has when the conversation opens', async () => {
    stubBridge(FIRST);
    await act(async () => {
      root.render(<AgentSession agentId={CHAT} working={true} />);
    });
    expect(still()?.src).toBe(FIRST);
  });

  it('replaces it with the next one the app sends', async () => {
    const { send } = stubBridge(FIRST);
    await act(async () => {
      root.render(<AgentSession agentId={CHAT} working={true} />);
    });
    await act(async () => {
      send({
        agentId: CHAT,
        portalId: 'studyo',
        title: 'Studyo',
        url: 'https://studyo.app/',
        frame: SECOND,
      });
    });
    expect(still()?.src).toBe(SECOND);
  });

  it("ignores a still from another conversation's browser", async () => {
    const { send } = stubBridge(FIRST);
    await act(async () => {
      root.render(<AgentSession agentId={CHAT} working={true} />);
    });
    await act(async () => {
      send({ agentId: OTHER, portalId: 'x', title: '', url: '', frame: SECOND });
    });
    expect(still()?.src).toBe(FIRST);
  });

  it('falls back to the placeholder when there is no still yet', async () => {
    stubBridge(null);
    await act(async () => {
      root.render(<AgentSession agentId={CHAT} working={true} />);
    });
    expect(still()).toBeNull();
    expect(container.textContent).toMatch(/Working in studyo/);
  });
});
