import { describe, expect, it } from 'vitest';
import { portalIdFor, sameSite, signInPortalFor } from './operations.mjs';

/**
 * Which saved sign-in a page may be filled with.
 *
 * A page on a connected site's own host or subdomain uses that site's
 * sign-in. The exception is the one the student asked for: a site that signs
 * in through Google sends them to accounts.google.com, and the sign-in they
 * saved for that site is the Google login it wants -- so during that site's
 * own flow, and only then, a Google sign-in page uses it too. A bare visit to
 * Google, with no connected site's flow behind it, gets nothing.
 */
describe('signInPortalFor', () => {
  const portals = [
    { id: 'studyo', origin: 'https://studyo.app' },
    { id: 'moodle', origin: 'https://moodle.school.example' },
  ];

  it('uses the site itself, whatever flow is remembered', () => {
    expect(signInPortalFor('https://accounts.studyo.app', portals, null)).toBe('studyo');
    expect(signInPortalFor('https://studyo.app', portals, 'moodle')).toBe('studyo');
  });

  it('uses the flow site on Google, during that site sign-in', () => {
    expect(signInPortalFor('https://accounts.google.com', portals, 'studyo')).toBe('studyo');
  });

  it('gives nothing on Google with no flow behind it', () => {
    expect(signInPortalFor('https://accounts.google.com', portals, null)).toBe(null);
  });

  it('gives nothing on Google when the flow site is gone', () => {
    expect(signInPortalFor('https://accounts.google.com', portals, 'deleted')).toBe(null);
  });

  it('does not let a flow leak the sign-in to some other site', () => {
    // Mid-Studyo, the page wanders to an unrelated site: the saved sign-in
    // stays for Studyo and its Google step, not for anywhere a page redirects.
    expect(signInPortalFor('https://evil.example', portals, 'studyo')).toBe(null);
    expect(signInPortalFor('https://login.microsoftonline.com', portals, 'studyo')).toBe(null);
  });
});

/**
 * Where a saved sign-in may go.
 *
 * Measured on Studyo: the site is studyo.app and its sign-in form is on
 * accounts.studyo.app, so an exact-origin rule refused to fill it. A site's
 * own subdomains are the site -- that is the rule a browser's password
 * manager uses too. Anything that merely contains the name is not.
 */
describe('sameSite', () => {
  it('matches the site itself', () => {
    expect(sameSite('https://studyo.app', 'https://studyo.app')).toBe(true);
  });

  it('matches a subdomain of the site, where sign-in forms live', () => {
    expect(sameSite('https://studyo.app', 'https://accounts.studyo.app')).toBe(true);
    expect(sameSite('https://studyo.app', 'https://login.eu.studyo.app')).toBe(true);
  });

  it('refuses a host that only contains the name', () => {
    expect(sameSite('https://studyo.app', 'https://studyo.app.evil.example')).toBe(false);
    expect(sameSite('https://studyo.app', 'https://evilstudyo.app')).toBe(false);
    expect(sameSite('https://studyo.app', 'https://studyo.apps')).toBe(false);
  });

  it('refuses the site over plain http, where a password would travel in the clear', () => {
    expect(sameSite('https://studyo.app', 'http://studyo.app')).toBe(false);
    expect(sameSite('https://studyo.app', 'http://accounts.studyo.app')).toBe(false);
  });

  it('refuses a parent of the site', () => {
    // The saved site is the subdomain; its parent is somebody else's page.
    expect(sameSite('https://portal.school.example', 'https://school.example')).toBe(false);
  });

  it('refuses junk', () => {
    expect(sameSite('https://studyo.app', 'not a url')).toBe(false);
    expect(sameSite('https://studyo.app', '')).toBe(false);
    expect(sameSite('https://studyo.app', null)).toBe(false);
  });
});

/**
 * Portal ids name a directory on disk holding a school session, so they have
 * to be filesystem-safe and stable, and two portals must never collide onto
 * one profile -- that would put a student's Veracross login and their Mozaik
 * login in the same Chrome profile.
 */
describe('portalIdFor', () => {
  it.each([
    ['Veracross', 'veracross'],
    ['Mozaïk', 'moza-k'],
    ['My School Portal', 'my-school-portal'],
    ['  spaced  out  ', 'spaced-out'],
    ['../../etc/passwd', 'etc-passwd'],
    ['!!!', 'portal'],
    ['', 'portal'],
  ])('%s -> %s', (name, expected) => {
    expect(portalIdFor(name)).toBe(expected);
  });

  it('never collides with an id already in use', () => {
    const existing = [{ id: 'veracross' }, { id: 'veracross-2' }];
    expect(portalIdFor('Veracross', existing)).toBe('veracross-3');
  });

  it('produces nothing that could escape the profiles directory', () => {
    for (const name of ['../..', 'a/b/c', '..\\..\\x', './.']) {
      expect(portalIdFor(name)).not.toMatch(/[/\\.]/);
    }
  });
});

describe('forgetDevice', () => {
  it('drops the credential but keeps configured portals', async () => {
    // Unlinking from the web must not make a student re-add every portal.
    const { forgetDevice } = await import('./operations.mjs');
    const { readConfig, writeConfig } = await import('./sync.mjs');
    const original = readConfig();
    try {
      writeConfig({
        token: 't',
        deviceId: 'd',
        deviceName: 'n',
        apiBase: 'https://x.test',
        portals: [{ id: 'veracross' }],
      });
      forgetDevice();
      const after = readConfig();
      expect(after.token).toBeUndefined();
      expect(after.deviceId).toBeUndefined();
      expect(after.portals).toEqual([{ id: 'veracross' }]);
      expect(after.apiBase).toBe('https://x.test');
    } finally {
      writeConfig(original);
    }
  });
});

describe('coalesce', () => {
  it('joins a run already in flight rather than starting a second', async () => {
    // Two Chrome instances on one profile directory is a hard failure, and it
    // would be recorded as the portal being broken.
    const { coalesce } = await import('./operations.mjs');
    const map = new Map();
    let starts = 0;
    const slow = () => {
      starts += 1;
      return new Promise((r) => setTimeout(() => r('done'), 30));
    };

    const [a, b] = await Promise.all([
      coalesce(map, 'veracross', slow),
      coalesce(map, 'veracross', slow),
    ]);
    expect(starts).toBe(1);
    expect([a, b]).toEqual(['done', 'done']);
  });

  it('does not block a different portal', async () => {
    const { coalesce } = await import('./operations.mjs');
    const map = new Map();
    let starts = 0;
    const slow = () => {
      starts += 1;
      return new Promise((r) => setTimeout(r, 10));
    };
    await Promise.all([coalesce(map, 'veracross', slow), coalesce(map, 'mozaik', slow)]);
    expect(starts).toBe(2);
  });

  it('releases the slot after a failure, so a retry is possible', async () => {
    const { coalesce } = await import('./operations.mjs');
    const map = new Map();
    await expect(coalesce(map, 'x', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(map.size).toBe(0);
    await expect(coalesce(map, 'x', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

/**
 * Whether a browser is put on screen at all.
 *
 * The window is only ever told about a session it has somewhere to show. A
 * scheduled sync has no conversation, and announcing it anyway drew a real
 * browser over whatever the student was looking at -- at the last bounds some
 * other chat reported, because a panel going away never clears them.
 */
describe('showsInChat', () => {
  it('shows a browser the conversation asked for', async () => {
    const { showsInChat } = await import('./operations.mjs');
    expect(showsInChat({ agentId: '11111111-1111-4111-8111-111111111111' })).toBe(true);
  });

  it('keeps a scheduled sync off the screen entirely', async () => {
    const { showsInChat } = await import('./operations.mjs');
    expect(showsInChat({ agentId: null })).toBe(false);
  });
});

/**
 * One browser-driving pass at a time.
 *
 * The work poll fires every three seconds and an item stays pending until it
 * is reported finished, so a page that takes ten seconds was picked up again
 * while it was still being read -- and the second browser evicted the first,
 * failing the very request the agent was waiting on. The student saw "could
 * not load" above a page that had plainly loaded.
 */
describe('oneAtATime', () => {
  it('runs the work', async () => {
    const { oneAtATime } = await import('./operations.mjs');
    const gate = oneAtATime();
    let ran = 0;
    expect(await gate(async () => void ran++)).toBe(true);
    expect(ran).toBe(1);
  });

  it('skips a pass that starts while one is still going', async () => {
    const { oneAtATime } = await import('./operations.mjs');
    const gate = oneAtATime();
    let started = 0;
    let release;
    const first = gate(async () => {
      started++;
      await new Promise((r) => (release = r));
    });

    expect(await gate(async () => void started++)).toBe(false);
    expect(started).toBe(1);

    release();
    await first;
  });

  it('lets the next pass run once the last one is done', async () => {
    const { oneAtATime } = await import('./operations.mjs');
    const gate = oneAtATime();
    await gate(async () => {});
    let ran = 0;
    expect(await gate(async () => void ran++)).toBe(true);
    expect(ran).toBe(1);
  });

  it('does not wedge shut when the work throws', async () => {
    // A portal that fails must not stop every later poll. This is the whole
    // reason the flag is released in a finally rather than after the call.
    const { oneAtATime } = await import('./operations.mjs');
    const gate = oneAtATime();
    await expect(
      gate(async () => {
        throw new Error('portal down');
      }),
    ).rejects.toThrow('portal down');
    expect(await gate(async () => {})).toBe(true);
  });
});
