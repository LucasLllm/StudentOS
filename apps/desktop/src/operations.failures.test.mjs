import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The suite's own log folder (vitest.config.ts), restored after each override. */
const TEST_LOG_DIR = process.env['CONTEXTO_LOG_DIR'];

/**
 * How the operations fail, each with its code. The browser, the crawl and the
 * server are replaced, so these run without Chrome, Electron or a network.
 */

vi.mock('./browser.mjs', () => ({
  PortalBrowser: class {
    async launch() {}
    async openPage() {
      return { sessionId: 'S' };
    }
    async close() {}
  },
}));
vi.mock('./explorer.mjs', () => ({
  explore: vi.fn(async () => ({
    exploredAt: '2026-10-09T12:00:00.000Z',
    pages: [],
    pagesVisited: 1,
    complete: true,
    needsLogin: false,
    redacted: false,
  })),
}));
vi.mock('./credentials.mjs', () => ({
  readCredentials: () => null,
  saveCredentials: () => {},
}));
const pushSnapshot = vi.fn();
vi.mock('./sync.mjs', async (original) => ({
  ...(await original()),
  pushSnapshot: (...args) => pushSnapshot(...args),
}));

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cx-ops-'));
  process.env['CONTEXTO_CONFIG_DIR'] = dir;
  process.env['CONTEXTO_LOG_DIR'] = dir;
  pushSnapshot.mockReset();
});
afterEach(() => {
  delete process.env['CONTEXTO_CONFIG_DIR'];
  process.env['CONTEXTO_LOG_DIR'] = TEST_LOG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const linked = (portals = [{ id: 'kognity', url: 'https://k.test/', origin: 'https://k.test' }]) =>
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ token: 't', apiBase: 'https://api.test', portals }),
  );

describe('operations, when they fail', () => {
  it('calls an address that is not one nav.invalid_url', async () => {
    const { browsePage } = await import('./operations.mjs');
    await expect(browsePage('not a url')).rejects.toMatchObject({ code: 'nav.invalid_url' });
  });

  it('calls acting with nothing open page.no_page_open', async () => {
    const { actOnPage } = await import('./operations.mjs');
    await expect(actOnPage({ action: 'look' })).rejects.toMatchObject({
      code: 'page.no_page_open',
    });
  });

  it('calls a sync on an unlinked computer sync.not_linked', async () => {
    const { syncPortal } = await import('./operations.mjs');
    await expect(syncPortal('kognity')).rejects.toMatchObject({ code: 'sync.not_linked' });
  });

  it('calls a sync of a site that is not there sync.unknown_site', async () => {
    linked();
    const { syncPortal } = await import('./operations.mjs');
    await expect(syncPortal('nowhere')).rejects.toMatchObject({ code: 'sync.unknown_site' });
  });

  it('calls a read that could not be sent sync.push_failed', async () => {
    linked([
      {
        id: 'kognity',
        url: 'https://k.test/',
        origin: 'https://k.test',
        loggedInAt: '2026-10-09T00:00:00.000Z',
      },
    ]);
    pushSnapshot.mockRejectedValue(new Error('fetch failed'));
    const { syncPortal } = await import('./operations.mjs');
    await expect(syncPortal('kognity')).rejects.toMatchObject({ code: 'sync.push_failed' });
  });

  it('calls a device the server no longer knows sync.device_unlinked', async () => {
    linked([
      {
        id: 'kognity',
        url: 'https://k.test/',
        origin: 'https://k.test',
        loggedInAt: '2026-10-09T00:00:00.000Z',
      },
    ]);
    const { DeviceUnlinked } = await import('./sync.mjs');
    pushSnapshot.mockRejectedValue(new DeviceUnlinked('gone'));
    const { syncPortal } = await import('./operations.mjs');
    await expect(syncPortal('kognity')).rejects.toMatchObject({ code: 'sync.device_unlinked' });
  });
});
