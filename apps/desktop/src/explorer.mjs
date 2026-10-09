/**
 * Letting the agent walk a portal itself.
 *
 * The alternative -- a human records traffic once and someone hand-writes an
 * adapter -- produces a map that is stale the first time the vendor ships a
 * redesign. Portals are uniform enough to explore instead: Veracross renders
 * every panel as /component/<Name>/<id>/load_data, and its PortalLinks
 * component returns the navigation tree, so the site describes itself.
 *
 * What comes back is a map of page -> components -> response shape. That map
 * IS the adapter, and it can be rebuilt on demand rather than maintained.
 *
 * Two rules bound the walk, and both are enforced here rather than in whatever
 * prompt is driving it. A model talked into wandering must still be unable to.
 *
 *   ORIGIN LOCK. Only the portal's own origin is ever navigated to or recorded.
 *   This browser profile holds a school session; an agent that could be steered
 *   to another origin is a confused deputy. It also drops the third-party
 *   telemetry (Sentry and friends) that would otherwise pollute the map.
 *
 *   PAGE BUDGET. Exploration stops at a fixed number of pages. A crawl with no
 *   ceiling is a crawl that hammers a school's server on a bad link cycle.
 */

import { summarizeShape } from './recorder.mjs';
import { Failure, note } from './trace.mjs';

const DEFAULT_BUDGET = 40;

/** Same-origin check. Sub-domains do not count -- a portal is one origin. */
export function isInScope(candidate, origin) {
  try {
    return new URL(candidate, origin).origin === new URL(origin).origin;
  } catch {
    // expected: not a URL, so not in scope.
    return false;
  }
}

/** Links a page offers, normalised and filtered to the portal itself. */
export function inScopeLinks(hrefs, origin, seen = new Set()) {
  const out = [];
  for (const href of hrefs) {
    if (!isInScope(href, origin)) continue;
    const url = new URL(href, origin);
    url.hash = '';
    const normalised = url.toString();
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(normalised);
  }
  return out;
}

/**
 * Load one page and report what it fetched for itself.
 *
 * @param {import('./browser.mjs').PortalBrowser} browser
 * @param {string} sessionId
 * @param {string} url
 */
export async function readPage(
  browser,
  sessionId,
  url,
  { origin, raw = false, settleMs = 2500 } = {},
) {
  if (!isInScope(url, origin)) throw new Error(`Refusing to navigate outside ${origin}: ${url}`);

  const cdp = browser.cdp;
  // Registering listeners is not enough -- CDP sends no Network events at all
  // until the domain is enabled, so without this every page reports zero
  // components and the map comes back structurally correct and empty.
  // Idempotent, so it is safe to call per page.
  await cdp.send('Network.enable', {}, sessionId);
  const inflight = new Map();
  const methods = new Map();
  const components = [];

  const offRequest = cdp.on(
    'Network.requestWillBeSent',
    (p) => methods.set(p.requestId, p.request.method),
    sessionId,
  );
  const offResponse = cdp.on(
    'Network.responseReceived',
    (p) => {
      if (!/json/i.test(p.response.mimeType)) return;
      // Origin lock applies to what we RECORD as well as where we navigate,
      // so third-party telemetry never enters the map.
      if (!isInScope(p.response.url, origin)) return;
      inflight.set(p.requestId, {
        url: p.response.url,
        status: p.response.status,
        method: methods.get(p.requestId) ?? 'GET',
      });
    },
    sessionId,
  );
  const offFinished = cdp.on(
    'Network.loadingFinished',
    async (p) => {
      const meta = inflight.get(p.requestId);
      if (!meta) return;
      inflight.delete(p.requestId);
      try {
        const { body, base64Encoded } = await cdp.send(
          'Network.getResponseBody',
          { requestId: p.requestId },
          sessionId,
        );
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        const parsed = JSON.parse(text);
        components.push({
          ...meta,
          shape: summarizeShape(parsed, { raw }),
          empty: isEmpty(parsed),
        });
      } catch (error) {
        // Not JSON, or the body was already gone. Kept as a component with no
        // shape, and the reason noted, so an empty sync can be explained.
        note('explore.unreadable_response', {
          url: meta.url,
          error: String(error?.message ?? error),
        });
        components.push({ ...meta, shape: null, empty: null });
      }
    },
    sessionId,
  );

  await browser.navigate(url, sessionId);
  // Components load after the load event, so give the XHRs a moment to land.
  await new Promise((r) => setTimeout(r, settleMs));

  const { result } = await cdp.send(
    'Runtime.evaluate',
    {
      expression: `JSON.stringify({
        title: document.title,
        text: document.body ? document.body.innerText.slice(0, 4000) : '',
        links: Array.from(document.querySelectorAll('a[href]')).map(a => a.href).slice(0, 300),
        // Where we ACTUALLY ended up, which is not necessarily where we asked
        // to go -- an expired session answers with a redirect to SSO.
        finalUrl: location.href,
        hasPasswordField: Boolean(document.querySelector('input[type=password]'))
      })`,
      returnByValue: true,
    },
    sessionId,
  );

  offRequest();
  offResponse();
  offFinished();

  const page = JSON.parse(result.value);
  return {
    url,
    finalUrl: page.finalUrl,
    title: page.title,
    text: page.text,
    links: page.links,
    hasPasswordField: page.hasPasswordField,
    components,
  };
}

/**
 * Did the portal bounce us to a login?
 *
 * Worth separating from "the portal is empty", because the two look identical
 * in the data -- every component returns nothing either way -- and the fixes
 * are completely different. Telling a student in August that their session
 * expired sends them to re-authenticate for no reason; telling them in
 * October that term has not started is simply wrong.
 *
 * Two signals, because portals do it both ways: most redirect to an SSO
 * origin, some render a login form in place at the same address.
 */
export function looksLikeLogin(page, origin) {
  return loginReason(page, origin) !== null;
}

/** Which of the two signals it was, so a sign-in prompt can be explained. */
export function loginReason(page, origin) {
  if (page.finalUrl && !isInScope(page.finalUrl, origin)) return 'off_origin';
  return page.hasPasswordField ? 'password_field' : null;
}

/** True when a payload carries structure but no rows -- an out-of-term portal. */
export function isEmpty(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') {
    const values = Object.values(value);
    return values.length > 0 && values.every((v) => isEmpty(v));
  }
  return false;
}

/**
 * Walk the portal breadth-first from a seed and build a map of it.
 *
 * @param {import('./browser.mjs').PortalBrowser} browser
 * @param {string} sessionId
 * @param {{ origin: string, seed: string, budget?: number, raw?: boolean, onPage?: Function }} options
 */
export async function explore(
  browser,
  sessionId,
  { origin, seed, budget = DEFAULT_BUDGET, raw = false, onPage },
) {
  const seen = new Set();
  const queue = inScopeLinks([seed], origin, seen);
  const pages = [];
  const skipped = [];

  let needsLogin = false;
  let loginWhy = null;

  while (queue.length > 0 && pages.length < budget) {
    const url = queue.shift();
    let page;
    try {
      page = await readPage(browser, sessionId, url, { origin, raw });
    } catch (error) {
      /*
       * The first page failing is the site failing, not one page of it: a
       * sync that carried on would report an empty site that read fine.
       */
      if (pages.length === 0 && skipped.length === 0) {
        if (error instanceof Failure) throw error;
        throw new Failure('nav.failed', undefined, { url, error: String(error?.message ?? error) });
      }
      note('explore.skipped', { url, code: error?.code ?? null, error: error.message });
      skipped.push({ url, reason: error.message, code: error?.code ?? null });
      continue;
    }

    // Checked on the first page only. Once bounced to a login, every
    // subsequent page is the same login, and crawling forty of them wastes
    // the budget and the school's bandwidth to learn nothing new.
    if (pages.length === 0 && looksLikeLogin(page, origin)) {
      needsLogin = true;
      loginWhy = loginReason(page, origin);
      note('explore.login_page', { why: loginWhy, finalUrl: page.finalUrl });
      break;
    }
    /*
     * The visible text is kept, not just the JSON.
     *
     * Only sites that render themselves from an API leave components behind.
     * A server-rendered portal -- which most are -- produces none at all, and
     * dropping its text meant the agent received a list of page titles and
     * nothing to read. Measured on four live sites: two returned JSON, two
     * returned none and would have arrived empty.
     */
    pages.push({
      url: page.url,
      title: page.title,
      text: raw ? page.text : undefined,
      components: page.components,
    });
    onPage?.(page);
    for (const link of inScopeLinks(page.links, origin, seen)) queue.push(link);
  }

  return {
    origin,
    exploredAt: new Date().toISOString(),
    redacted: !raw,
    // A truncated crawl that reports itself as complete is worse than no crawl,
    // because everything downstream treats the gap as "this portal has no
    // grades page" rather than "we stopped early".
    complete: queue.length === 0 && !needsLogin,
    /** The session expired. Distinct from a portal that is merely empty. */
    needsLogin,
    loginWhy,
    pagesVisited: pages.length,
    pagesRemaining: queue.length,
    budget,
    pages,
    skipped,
  };
}
