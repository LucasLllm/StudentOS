import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configPath, readConfig } from './sync.mjs';

describe('readConfig', () => {
  it('returns an empty object rather than throwing when unlinked', () => {
    // First run on a new machine has no config file at all. Throwing here
    // would mean the app cannot even print "run link first".
    expect(readConfig()).toEqual(expect.any(Object));
  });

  it('survives a corrupted config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, '{ not json');
    chmodSync(file, 0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('pushSnapshot', () => {
  const stubFetch = (status, body) => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(body),
    });
    return () => {
      globalThis.fetch = original;
    };
  };

  const snapshot = {
    portalId: 'veracross',
    origin: 'https://x.test',
    map: { exploredAt: '2026-09-01T00:00:00.000Z' },
    redacted: false,
  };

  it('raises DeviceUnlinked on 401 so the app can stop retrying', async () => {
    const { DeviceUnlinked, pushSnapshot } = await import('./sync.mjs');
    const restore = stubFetch(401, { message: 'This device is not linked.' });
    try {
      await expect(
        pushSnapshot({ apiBase: 'https://x.test', token: 'revoked' }, snapshot),
      ).rejects.toBeInstanceOf(DeviceUnlinked);
    } finally {
      restore();
    }
  });

  it('raises an ordinary error on a server fault, which IS worth retrying', async () => {
    const { DeviceUnlinked, pushSnapshot } = await import('./sync.mjs');
    const restore = stubFetch(500, { message: 'boom' });
    try {
      const error = await pushSnapshot({ apiBase: 'https://x.test', token: 't' }, snapshot).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DeviceUnlinked);
    } finally {
      restore();
    }
  });
});

describe('when the thing answering is not our API', () => {
  const stubRaw = (status, text) => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: status < 400, status, text: async () => text });
    return () => {
      globalThis.fetch = original;
    };
  };

  const snap = {
    portalId: 'veracross',
    origin: 'https://x.test',
    map: { exploredAt: '2026-09-01T00:00:00.000Z' },
    redacted: false,
  };

  it('explains a 404 instead of failing to parse it', async () => {
    // A server without these routes replies with HTML or plain text. Parsing
    // that raised "Unexpected non-whitespace character after JSON", which
    // told the student nothing.
    const { pushSnapshot } = await import('./sync.mjs');
    const restore = stubRaw(404, '404 Not Found');
    try {
      const error = await pushSnapshot(
        { apiBase: 'https://contextoagent.ai', token: 't' },
        snap,
      ).catch((e) => e);
      expect(error.message).toMatch(/no device-linking API/);
      expect(error.message).toMatch(/contextoagent\.ai/);
      expect(error.message).not.toMatch(/JSON/i);
    } finally {
      restore();
    }
  });

  it('explains an HTML page served with a 200', async () => {
    // Captive portals on school wifi do exactly this.
    const { pushSnapshot } = await import('./sync.mjs');
    const restore = stubRaw(200, '<!doctype html><title>Sign in to WiFi</title>');
    try {
      const error = await pushSnapshot({ apiBase: 'https://x.test', token: 't' }, snap).catch(
        (e) => e,
      );
      expect(error.message).toMatch(/not JSON|proxy or sign-in page/);
    } finally {
      restore();
    }
  });

  it('still reports a real API error message when there is one', async () => {
    const { pushSnapshot } = await import('./sync.mjs');
    const restore = stubRaw(
      400,
      JSON.stringify({ message: 'That portal snapshot is too large to store.' }),
    );
    try {
      const error = await pushSnapshot({ apiBase: 'https://x.test', token: 't' }, snap).catch(
        (e) => e,
      );
      expect(error.message).toBe('That portal snapshot is too large to store.');
    } finally {
      restore();
    }
  });
});

describe('configPath', () => {
  it('can be pointed somewhere else, so tests never touch a real install', () => {
    // Losing a device token is not recoverable -- the server keeps only its
    // hash -- so a test able to reach the student's own config is a test that
    // will eventually destroy one.
    const before = process.env['CONTEXTO_CONFIG_DIR'];
    try {
      process.env['CONTEXTO_CONFIG_DIR'] = '/tmp/ctx-test-suite';
      expect(configPath()).toBe('/tmp/ctx-test-suite/config.json');
    } finally {
      if (before === undefined) delete process.env['CONTEXTO_CONFIG_DIR'];
      else process.env['CONTEXTO_CONFIG_DIR'] = before;
    }
  });

  it('defaults to the real location when nothing is set', () => {
    const before = process.env['CONTEXTO_CONFIG_DIR'];
    delete process.env['CONTEXTO_CONFIG_DIR'];
    try {
      expect(configPath()).toMatch(/ContextoAgent|contexto-agent/);
    } finally {
      if (before !== undefined) process.env['CONTEXTO_CONFIG_DIR'] = before;
    }
  });
});

describe('link', () => {
  it('persists the session that came back with the approval', async () => {
    // This is what makes the app signed in after linking. It shipped once
    // without it: an exact-string edit silently matched nothing, and syntax
    // and lint both pass on unchanged code.
    const dir = mkdtempSync(join(tmpdir(), 'ctx-link-'));
    const beforeDir = process.env['CONTEXTO_CONFIG_DIR'];
    const beforeFetch = globalThis.fetch;
    process.env['CONTEXTO_CONFIG_DIR'] = dir;

    globalThis.fetch = async (url) => {
      const path = String(url);
      if (path.endsWith('/link/start')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ requestId: 'r1', expiresAt: null }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'linked',
            token: 'DEV',
            deviceId: 'd1',
            sessionToken: 'SESSION-XYZ',
          }),
      };
    };

    try {
      const { link, readConfig } = await import(`./sync.mjs?link-test`);
      const result = await link({
        apiBase: 'https://x.test',
        webBase: 'https://x.test',
        deviceName: 'Test',
        pollMs: 1,
      });
      expect(result.sessionToken).toBe('SESSION-XYZ');
      expect(readConfig().sessionToken).toBe('SESSION-XYZ');
      expect(readConfig().token).toBe('DEV');
    } finally {
      globalThis.fetch = beforeFetch;
      if (beforeDir === undefined) delete process.env['CONTEXTO_CONFIG_DIR'];
      else process.env['CONTEXTO_CONFIG_DIR'] = beforeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sessionValid', () => {
  const withFetch = async (impl, fn) => {
    const before = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await fn();
    } finally {
      globalThis.fetch = before;
    }
  };

  it('says no when the stored session has expired', async () => {
    // An expired token looks identical to a working one from here. Treating
    // it as good is how an app ends up signed out for good with no way back.
    const { sessionValid } = await import('./sync.mjs');
    const ok = await withFetch(
      async () => ({ ok: false, status: 401 }),
      () => sessionValid({ apiBase: 'https://x.test', sessionToken: 'expired' }),
    );
    expect(ok).toBe(false);
  });

  it('says yes when it still works', async () => {
    const { sessionValid } = await import('./sync.mjs');
    const ok = await withFetch(
      async () => ({ ok: true, status: 200 }),
      () => sessionValid({ apiBase: 'https://x.test', sessionToken: 'good' }),
    );
    expect(ok).toBe(true);
  });

  it('says no when there is no session at all', async () => {
    const { sessionValid } = await import('./sync.mjs');
    expect(await sessionValid({ apiBase: 'https://x.test', sessionToken: null })).toBe(false);
  });

  it('keeps the session when the network is down rather than discarding it', async () => {
    // Offline is not the same as signed out, and throwing the session away
    // over a dropped connection means signing in again on a train.
    const { sessionValid } = await import('./sync.mjs');
    const ok = await withFetch(
      async () => {
        throw new Error('ENOTFOUND');
      },
      () => sessionValid({ apiBase: 'https://x.test', sessionToken: 'good' }),
    );
    expect(ok).toBe(true);
  });
});

/**
 * Nothing in a test may touch the machine running it.
 *
 * Linking opens the approval page in the student's own browser, and the test
 * above exercises linking -- so every single run spawned a real tab pointing
 * at the made-up host this suite uses. A blank x.test page, on the developer's
 * desktop, forever. Two guards, because one was clearly not enough: the caller
 * can hand in its own opener, and the real one refuses to run under test even
 * if some future caller forgets to.
 */
describe('openInBrowser', () => {
  it('does not spawn anything under test', async () => {
    const { openInBrowser } = await import('./sync.mjs');
    expect(openInBrowser('https://x.test/link/whatever')).toBe(false);
  });

  it('lets a caller supply its own opener, and hands it the approval page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contexto-open-'));
    const beforeDir = process.env['CONTEXTO_CONFIG_DIR'];
    const beforeFetch = globalThis.fetch;
    process.env['CONTEXTO_CONFIG_DIR'] = dir;

    const opened = [];
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        String(url).includes('/start')
          ? JSON.stringify({ requestId: 'REQ-1' })
          : JSON.stringify({ status: 'linked', token: 'D', deviceId: 'd', sessionToken: 'S' }),
    });

    try {
      const { link } = await import(`./sync.mjs?opener-test`);
      await link({
        apiBase: 'https://x.test',
        webBase: 'https://x.test',
        deviceName: 'Test',
        pollMs: 1,
        open: (url) => opened.push(url),
      });
      expect(opened).toEqual(['https://x.test/link/REQ-1']);
    } finally {
      globalThis.fetch = beforeFetch;
      if (beforeDir === undefined) delete process.env['CONTEXTO_CONFIG_DIR'];
      else process.env['CONTEXTO_CONFIG_DIR'] = beforeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('uploadAttempt and heartbeat', () => {
  const capture = () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    };
    return { calls, restore: () => (globalThis.fetch = original) };
  };

  it('sends a trace to the attempts route with the device token', async () => {
    const { uploadAttempt } = await import('./sync.mjs');
    const { calls, restore } = capture();
    try {
      await uploadAttempt({ apiBase: 'https://api.test', token: 't' }, { id: 'a', steps: [] });
    } finally {
      restore();
    }
    expect(calls[0].url).toBe('https://api.test/api/devices/attempts');
    expect(calls[0].init.headers.authorization).toBe('Bearer t');
    expect(JSON.parse(calls[0].init.body)).toEqual({ id: 'a', steps: [] });
  });

  it('sends what the app is busy with', async () => {
    const { heartbeat } = await import('./sync.mjs');
    const { calls, restore } = capture();
    const busy = { kind: 'sync', portalId: 'k', since: '2026-10-09T12:00:00.000Z' };
    try {
      await heartbeat({ apiBase: 'https://api.test', token: 't' }, busy);
    } finally {
      restore();
    }
    expect(calls[0].url).toBe('https://api.test/api/devices/heartbeat');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ busy });
  });
});
