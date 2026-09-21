/**
 * What the app can actually do, independent of who is asking.
 *
 * The CLI and the window both call these. Keeping them here rather than in
 * either front end is what stops the Electron build and the `sync` command
 * drifting into two subtly different products -- the failure that would show
 * up as "it works in the terminal but not in the app".
 */

import { PortalBrowser } from './browser.mjs';
import { fillScript, explainFailure, INSPECT_SCRIPT } from './sign-in.mjs';
import { readCredentials, saveCredentials } from './credentials.mjs';
import { explore } from './explorer.mjs';
import { ActionError, SNAPSHOT_SCRIPT, performAction } from './page-actions.mjs';
import { DeviceUnlinked, pushSnapshot, readConfig, writeConfig } from './sync.mjs';

/**
 * Open a browser for a site.
 *
 * Inside the app that is a view the student can watch; from the command line
 * there is no Electron to host one, so it falls back to driving Chrome. Both
 * present the same surface, which is why the explorer does not know or care
 * which it got.
 */
let onSessionOpen = null;
let onSessionClose = null;

/** Let the app show what the agent is doing. Optional: the CLI sets neither. */
export function observeSessions({ open, close }) {
  onSessionOpen = open;
  onSessionClose = close;
}

/** Set while doing work an agent asked for, so its browser can be shown there. */
let workingForAgent = null;

export function setWorkingForAgent(agentId) {
  workingForAgent = agentId ?? null;
}

/**
 * Whether a browser should be put on screen at all.
 *
 * Only work a conversation asked for has anywhere to appear. A scheduled
 * refresh, a "Sync now" from the Sites list, or adding a site belongs in no
 * chat -- and showing one anyway does not mean showing it harmlessly: the
 * window draws it at the last bounds some conversation reported, because a
 * panel going away deliberately never clears them. The student gets a browser
 * over whatever they were looking at, for work they never asked for.
 */
export function showsInChat(session) {
  return Boolean(session?.agentId);
}

async function openBrowser(portalId) {
  if (process.versions.electron) {
    const { SiteSession } = await import('./site-session.mjs');
    const session = new SiteSession({ portalId, agentId: workingForAgent });
    await session.launch();
    // Nowhere to show it, so the window is never told it exists. It still
    // runs, and still reads the portal; it just does so out of sight.
    if (!showsInChat(session)) return session;
    onSessionOpen?.(session);
    const close = session.close.bind(session);
    session.close = async () => {
      onSessionClose?.(session);
      await close();
    };
    return session;
  }
  const browser = new PortalBrowser({ portalId, mode: 'drive', visible: false });
  await browser.launch();
  return browser;
}

/**
 * A gate that admits one pass at a time and turns the rest away.
 *
 * Everything that drives a browser shares one of these. There is a single
 * browser view, a single "which conversation is this for" flag, and a single
 * active session, and two passes running at once corrupt all three: the
 * newcomer's session evicts the incumbent's, destroying a page that was still
 * being read, and tagging it with whichever agent happened to be set.
 *
 * Turned away rather than queued. These are polls -- the next one is three
 * seconds behind, and the pending work will still be pending. A queue would
 * pile up a run for every tick that happened during a slow page.
 */
export function oneAtATime() {
  let busy = false;
  return async (fn) => {
    if (busy) return false;
    busy = true;
    try {
      await fn();
      return true;
    } finally {
      // In a finally, so one failing portal cannot wedge the gate shut and
      // silently stop every poll for the life of the app.
      busy = false;
    }
  };
}

/** Syncs currently running, keyed by portal. */
const inFlight = new Map();

/**
 * Run `start` for `key`, or join the run already going.
 *
 * Chrome refuses to open two instances on one profile directory, and every
 * portal has exactly one profile. So a scheduled sync overlapping a student
 * pressing "Sync now" -- or the sync fired right after a login finishing --
 * would fail on a profile lock and be recorded as if the portal were broken.
 *
 * Joining rather than refusing, because the caller wanted a fresh read and
 * one is already happening; its result is the answer they asked for.
 */
export function coalesce(map, key, start) {
  const running = map.get(key);
  if (running) return running;
  const promise = start().finally(() => map.delete(key));
  map.set(key, promise);
  return promise;
}

export function listPortals() {
  return readConfig().portals ?? [];
}

export function status() {
  const config = readConfig();
  return {
    linked: Boolean(config.token),
    deviceName: config.deviceName ?? null,
    portals: config.portals ?? [],
  };
}

/** A stable, filesystem-safe key derived from the portal's name. */
export function portalIdFor(name, existing = []) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'portal';
  if (!existing.some((p) => p.id === base)) return base;
  let n = 2;
  while (existing.some((p) => p.id === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function addPortal({ name, url }) {
  const config = readConfig();
  const portals = config.portals ?? [];
  // Throwing here rather than in the UI keeps the CLI honest about it too.
  const origin = new URL(url).origin;
  const portal = { id: portalIdFor(name, portals), name, url, origin, lastSyncedAt: null };
  writeConfig({ ...config, portals: [...portals, portal] });
  return portal;
}

/**
 * Add a site and get it working, in one action.
 *
 * Adding a site and signing into it were two steps, and the gap between them
 * was where it went wrong: a site could sit in the list looking added while
 * never having fetched anything. Now the sign-in is part of adding, and the
 * result says which of the three things happened -- signed in and synced,
 * signed in but nothing there, or the site refused the sign-in.
 */
export async function addSiteWithSignIn({ name, url, username, password }) {
  const portal = addPortal({ name, url });
  try {
    saveCredentials(portal.id, { username, password });
  } catch (error) {
    removePortal(portal.id);
    throw error;
  }

  const signedIn = await autoSignIn(portal.id);
  if (!signedIn.ok) {
    return { portal, signedIn: false, reason: signedIn.reason ?? 'the site refused that sign-in' };
  }

  // No second look needed: signing in recorded where the site put us, which
  // is the site. Opening another browser to ask again would only be a chance
  // to get a different answer.
  const result = await syncPortal(portal.id);
  return { portal, signedIn: true, synced: true, landed: signedIn.landed, result };
}

/**
 * The page the agent last left open, if it is still there.
 *
 * Held so the next step can land on it. Gone once a sync or a different site
 * has replaced it, or the window took it down -- and then the agent has to
 * open a page before it can do anything to one.
 */
let current = null;

function pageLeftOpen() {
  const page = current;
  if (!page?.view || !page.webContents || page.webContents.isDestroyed()) {
    current = null;
    return null;
  }
  return page;
}

/** Pick a page the agent left open back up, and show it as working again. */
function resumeBrowser(session) {
  session.attach();
  onSessionOpen?.(session);
  return session;
}

/**
 * Open one page and read it back.
 *
 * Ordinary browsing, in the same browser that signs into the student's sites.
 * If the address belongs to a site they have connected it reuses that site's
 * session, so a page behind a login they already have simply opens -- which
 * is most of the reason to browse from their machine rather than the server.
 */
export async function browsePage(url) {
  const target = new URL(url);
  const site = listPortals().find((p) => p.origin === target.origin);
  // Only a name now: every view shares one store, so a page behind a login
  // the student has anywhere in it simply opens. A connected site is called
  // by its name in the conversation; anything else by its host.
  const label = site ? site.id : target.host;

  /*
   * The same view, when it is the same conversation.
   *
   * Following a link the agent was just looking at replaces nothing: the
   * view the student is watching goes where it was told, the way a tab does,
   * whatever site the link leads to. Only a different conversation gets a
   * view of its own.
   */
  const open = pageLeftOpen();
  const same = open && showsInChat(open) && open.agentId === workingForAgent;
  if (same) open.portalId = label;
  const browser = same ? resumeBrowser(open) : await openBrowser(label);
  current = browser.view ? browser : null;
  try {
    await browser.openPage(target.toString());
    // Give a page that builds itself a moment to do so.
    await new Promise((r) => setTimeout(r, 2500));
    const read = await evaluate(browser, SNAPSHOT_SCRIPT);
    await browser.close();
    return JSON.parse(read);
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/**
 * Do one thing to the page the agent has open, and read it back.
 *
 * Only the page this conversation opened. Another conversation's page is on
 * screen somewhere else and belongs to whoever asked for it; acting on it
 * from here would be doing one student's work in another's window.
 */
export async function actOnPage(action) {
  const page = pageLeftOpen();
  if (!page || !showsInChat(page) || page.agentId !== workingForAgent) {
    throw new ActionError(
      'There is no page open in this conversation. Open one with browser_open first.',
    );
  }
  const browser = resumeBrowser(page);
  try {
    const read = await performAction(browser, action);
    await browser.close();
    return read;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export function removePortal(portalId) {
  const config = readConfig();
  writeConfig({ ...config, portals: (config.portals ?? []).filter((p) => p.id !== portalId) });
}

/** Drop this machine's credential, keeping the portals it has configured. */
export function forgetDevice() {
  const { token: _token, deviceId: _deviceId, deviceName: _deviceName, ...rest } = readConfig();
  writeConfig(rest);
}

function updatePortal(portalId, patch) {
  const config = readConfig();
  writeConfig({
    ...config,
    portals: (config.portals ?? []).map((p) => (p.id === portalId ? { ...p, ...patch } : p)),
  });
}

/**
 * Sign in without the student, using a sign-in they chose to remember.
 *
 * Only works for a plain username-and-password form. A site behind Google or
 * any other SSO is deliberately out of reach: that flow is designed to detect
 * automation, and defeating it would mean teaching this app to look like
 * something it is not. Those sites keep the two-step sign-in a person does.
 *
 * The credentials are read from the keychain at the moment they are typed
 * into the page and are never written anywhere else, never logged, and never
 * sent to the server.
 */
export async function autoSignIn(portalId) {
  const portal = listPortals().find((p) => p.id === portalId);
  if (!portal) throw new Error(`No site called ${portalId}`);

  const saved = readCredentials(portalId);
  if (!saved) return { attempted: false, reason: 'no saved sign-in' };

  const browser = await openBrowser(portalId);
  try {
    const { sessionId } = await browser.openPage(portal.url);
    await new Promise((r) => setTimeout(r, 1500));

    const filled = await evaluate(browser, fillScript(saved.username, saved.password), sessionId);
    if (filled !== 'submitted') {
      await browser.close();
      return { attempted: true, ok: false, reason: explainFailure(filled) };
    }

    // Let the sign-in land, then ask the same question a person would: are we
    // still looking at a password box?
    await new Promise((r) => setTimeout(r, 4000));
    const { stillAsking, landed } = JSON.parse(await evaluate(browser, INSPECT_SCRIPT, sessionId));
    await browser.close();

    if (stillAsking) return { attempted: true, ok: false, reason: 'still asking for a password' };

    /*
     * Where the sign-in put us IS the site.
     *
     * A student pastes the address they know, which is the sign-in page;
     * Veracross signs you in at accounts.veracross.com and hands you to
     * portals.veracross.com. Seeding a crawl at the sign-in page reads a
     * password form and calls the session dead, however good it is. Nothing
     * is guessed here -- the site said where it keeps this student's things
     * by taking us there.
     */
    updatePortal(portalId, {
      loggedInAt: new Date().toISOString(),
      lastError: null,
      url: landed,
      origin: new URL(landed).origin,
    });
    return { attempted: true, ok: true, landed };
  } catch {
    await browser.close().catch(() => {});
    // The error is deliberately not passed on: it can carry the page's own
    // text, and a rejected sign-in page is exactly where a typed password
    // gets echoed back.
    return { attempted: true, ok: false, reason: 'the sign-in could not be completed' };
  }
}

/** Read from the page, whichever browser this is. */
async function evaluate(browser, expression, sessionId) {
  if (browser.evaluate) return browser.evaluate(expression);
  const { result } = await browser.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    sessionId,
  );
  return result?.value;
}

/**
 * Read a portal and push what it found.
 *
 * Values, not shapes -- this feeds the student's own agent, which cannot
 * answer "what is due Friday" from `string<date>`.
 */
export function syncPortal(portalId, options = {}) {
  return coalesce(inFlight, portalId, () => runSync(portalId, options));
}

async function runSync(portalId, { budget = 40, retried = false } = {}) {
  const config = readConfig();
  if (!config.token) throw new Error('This computer is not linked yet.');
  const portal = (config.portals ?? []).find((p) => p.id === portalId);
  if (!portal) throw new Error(`No portal called ${portalId}`);

  /*
   * A remembered sign-in makes a dead session self-healing.
   *
   * Checking loggedInAt was not enough: a session can be gone while that flag
   * still says otherwise -- it expired, the site signed us out, or the
   * browser itself changed and took its cookie store with it. The crawl is
   * the only thing that actually knows, so the recovery happens after it
   * rather than before, and only once.
   *
   * Without this the student finds out days later, when they ask the agent
   * something and it says the site needs signing into again -- a worse way to
   * learn it than never noticing at all.
   */
  if (!portal.loggedInAt && readCredentials(portalId)) {
    const recovered = await autoSignIn(portalId);
    if (recovered.ok) portal.loggedInAt = new Date().toISOString();
  }

  const browser = await openBrowser(portalId);
  try {
    const { sessionId } = await browser.openPage('about:blank');
    const map = await explore(browser, sessionId, {
      origin: portal.origin,
      seed: portal.url,
      budget,
      raw: true,
    });
    await browser.close();

    await pushSnapshot(
      { apiBase: config.apiBase ?? 'https://contextoagent.ai', token: config.token },
      { portalId, origin: portal.origin, map, redacted: map.redacted },
    );

    /*
     * The crawl found a sign-in page. If there is a saved sign-in, use it and
     * look again -- once. Reporting an empty site when the means to fix it is
     * sitting in the keychain is the wrong answer.
     */
    if (map.needsLogin && !retried && readCredentials(portalId)) {
      await browser.close();
      const recovered = await autoSignIn(portalId);
      if (recovered.ok) return runSync(portalId, { budget, retried: true });
    }

    const components = map.pages.flatMap((p) => p.components);
    const withData = components.filter((c) => c.empty === false);
    const result = {
      pages: map.pagesVisited,
      components: components.length,
      withData: withData.length,
      complete: map.complete,
      needsLogin: map.needsLogin,
      syncedAt: new Date().toISOString(),
    };
    // Clearing loggedInAt puts the portal back to offering "Sign in", which is
    // the only action that helps. Leaving it set would show a Sync button that
    // is guaranteed to fail the same way.
    updatePortal(portalId, {
      lastSyncedAt: result.syncedAt,
      lastResult: result,
      lastError: null,
      ...(map.needsLogin ? { loggedInAt: null } : {}),
    });
    return result;
  } catch (error) {
    // A browser left running holds a lock on the profile directory, so the
    // next sync would fail for a reason unrelated to what actually broke.
    await browser.close().catch(() => {});

    if (error instanceof DeviceUnlinked) {
      // Someone unlinked this computer from the web app. Dropping the token
      // returns the window to "Link this computer", which is the only thing
      // that helps; keeping it would retry every six hours forever.
      forgetDevice();
    } else {
      updatePortal(portalId, { lastError: String(error.message ?? error) });
    }
    throw error;
  }
}
