import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseExit, profileDirFor, launchArgs } from './browser.mjs';
import { findBrowser } from './chrome.mjs';

describe('profileDirFor', () => {
  it('refuses a portal id that could escape the profile root', () => {
    expect(() => profileDirFor('../../.ssh')).toThrow(/Invalid portal id/);
    expect(() => profileDirFor('veracross/../..')).toThrow(/Invalid portal id/);
  });

  it('gives each portal its own directory', () => {
    expect(profileDirFor('veracross')).not.toBe(profileDirFor('mozaik'));
  });

  it('never points at the real Chrome profile', () => {
    // The whole safety argument rests on this: our profile is not the one the
    // student is signed into Google with, so Gmail and Drive stay behind OAuth.
    expect(profileDirFor('veracross')).not.toMatch(/Google\/Chrome$/);
  });
});

describe('diagnoseExit', () => {
  it('names the enterprise policy when an admin has blocked debugging', () => {
    const message = diagnoseExit(1, 'ERROR: Remote debugging is disallowed by the system admin');
    expect(message).toMatch(/administrator/i);
    expect(message).toMatch(/personal computer/i);
  });

  it('explains a profile already in use', () => {
    expect(
      diagnoseExit(21, 'Failed to create a ProcessSingleton for your profile directory'),
    ).toMatch(/already open/i);
  });

  it('falls back to the exit code with captured stderr', () => {
    expect(diagnoseExit(127, 'dyld: library not loaded')).toMatch(/127/);
  });
});

describe('findBrowser', () => {
  /*
   * Asked about a made-up machine, not the one running the tests.
   *
   * This used to assert that a Chromium browser existed on whatever box ran
   * the suite -- which tests the box, not the code, and fails on any CI runner
   * without Chrome installed. What is worth pinning is the order of
   * preference and that an unreadable path is skipped; both are properties of
   * the lookup, so the lookup is what gets handed a fake.
   */
  const installed =
    (...present) =>
    (path) =>
      present.some((p) => path === p);

  it('finds Chrome where macOS puts it', () => {
    const found = findBrowser('darwin', {
      executable: installed('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    });
    expect(found).toEqual({
      brand: 'chrome',
      path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
  });

  it('prefers Chrome over Edge when both are installed', () => {
    // School SSO is tested against Chrome; Edge is the fallback, not the pick.
    const found = findBrowser('darwin', {
      executable: installed(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ),
    });
    expect(found.brand).toBe('chrome');
  });

  it('falls back to Edge when Chrome is absent', () => {
    const found = findBrowser('darwin', {
      executable: installed('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    });
    expect(found.brand).toBe('edge');
  });

  it('asks PATH on Linux, where installs land wherever the distro puts them', () => {
    const found = findBrowser('linux', {
      which: (binary) => (binary === 'google-chrome' ? '/usr/bin/google-chrome' : null),
      executable: installed('/usr/bin/google-chrome'),
    });
    expect(found).toEqual({ brand: 'chrome', path: '/usr/bin/google-chrome' });
  });

  it('throws a student-readable error when nothing is installed', () => {
    expect(() => findBrowser('sunos')).toThrow(/Install Chrome/);
    expect(() => findBrowser('darwin', { executable: () => false })).toThrow(/Install Chrome/);
  });
});

describe('launchArgs', () => {
  const base = { profileDir: '/tmp/profile', visible: false, startUrl: null };

  it('always restores the last session', () => {
    // Portal logins are session cookies, which Chrome discards on exit. Without
    // this flag closing the login window destroyed the login it had just been
    // opened to capture. Measured: 0 restarts survived without, 3 of 3 with.
    expect(launchArgs({ ...base, driving: true })).toContain('--restore-last-session');
    expect(launchArgs({ ...base, driving: false })).toContain('--restore-last-session');
  });

  it('opens a debugging channel only when driving', () => {
    // The sign-in page must see an ordinary browser; only reading needs CDP.
    expect(launchArgs({ ...base, driving: true })).toContain('--remote-debugging-pipe');
    expect(launchArgs({ ...base, driving: false })).not.toContain('--remote-debugging-pipe');
  });

  it('never runs headless, which would advertise automation', () => {
    const args = launchArgs({ ...base, driving: true });
    expect(args.join(' ')).not.toMatch(/--headless/);
    expect(args).toContain('--window-position=-32000,-32000');
  });

  it('shows a real window when visible', () => {
    expect(launchArgs({ ...base, driving: false, visible: true }).join(' ')).not.toMatch(
      /window-position/,
    );
  });

  it('always points at the isolated profile', () => {
    expect(launchArgs({ ...base, driving: true })).toContain('--user-data-dir=/tmp/profile');
  });

  it('starts at the requested url, or blank', () => {
    expect(launchArgs({ ...base, driving: false, startUrl: 'https://x.test/' }).at(-1)).toBe(
      'https://x.test/',
    );
    expect(launchArgs({ ...base, driving: true }).at(-1)).toBe('about:blank');
  });
});

describe('profile directory permissions', () => {
  it('is created owner-only, because it holds a school session', async () => {
    // Default 0755 would let every other account on a shared Mac read the
    // profile. Chrome encrypts the cookie store against the keychain, so this
    // is depth rather than the only barrier -- but it costs nothing.
    const root = mkdtempSync(join(tmpdir(), 'ctx-profile-'));
    const before = process.env['CONTEXTO_CONFIG_DIR'];
    process.env['CONTEXTO_CONFIG_DIR'] = root;
    try {
      const { PortalBrowser } = await import('./browser.mjs');
      const browser = new PortalBrowser({ portalId: 'perm-test' });
      // launch() would spawn Chrome; the directory is made on the way there,
      // so create it the same way the constructor path does.
      const { mkdirSync, chmodSync } = await import('node:fs');
      mkdirSync(browser.profileDir, { recursive: true, mode: 0o700 });
      chmodSync(browser.profileDir, 0o700);
      expect(statSync(browser.profileDir).mode & 0o777).toBe(0o700);
    } finally {
      if (before === undefined) delete process.env['CONTEXTO_CONFIG_DIR'];
      else process.env['CONTEXTO_CONFIG_DIR'] = before;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('where profiles are written', () => {
  it('follows CONTEXTO_CONFIG_DIR, so a test never writes into a real install', () => {
    // It did not, for several days. The override was added to the config path
    // and not to this one, so the suite kept creating profile directories in
    // a student's own app data on every run. Read at call time, so no module
    // reloading is needed to check it.
    const before = process.env['CONTEXTO_CONFIG_DIR'];
    process.env['CONTEXTO_CONFIG_DIR'] = '/tmp/ctx-profile-root-test';
    try {
      expect(profileDirFor('anything')).toBe('/tmp/ctx-profile-root-test/portals/anything');
    } finally {
      if (before === undefined) delete process.env['CONTEXTO_CONFIG_DIR'];
      else process.env['CONTEXTO_CONFIG_DIR'] = before;
    }
  });

  it('uses the real location when nothing is set', () => {
    const before = process.env['CONTEXTO_CONFIG_DIR'];
    delete process.env['CONTEXTO_CONFIG_DIR'];
    try {
      expect(profileDirFor('veracross')).toMatch(/ContextoAgent|contexto-agent/);
      expect(profileDirFor('veracross')).not.toMatch(/^\/tmp/);
    } finally {
      if (before !== undefined) process.env['CONTEXTO_CONFIG_DIR'] = before;
    }
  });
});

describe('PortalBrowser.navigate', () => {
  it('throws the right code when Chrome says the navigation failed', async () => {
    const { PortalBrowser } = await import('./browser.mjs');
    const browser = new PortalBrowser({ portalId: 'x', mode: 'drive' });
    browser.cdp = {
      on: () => () => {},
      send: async () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
    };
    await expect(browser.navigate('https://nowhere.test/', 'S')).rejects.toMatchObject({
      code: 'nav.dns',
      detail: { errorText: 'net::ERR_NAME_NOT_RESOLVED' },
    });
  });
});
