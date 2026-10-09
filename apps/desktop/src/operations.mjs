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
import { readCredentials, saveCredentials, savedSignIn } from './credentials.mjs';
import { needsLoginFailure } from './work.mjs';
import { explore } from './explorer.mjs';
import { SNAPSHOT_SCRIPT, performAction } from './page-actions.mjs';
import { DeviceUnlinked, pushSnapshot, readConfig, writeConfig } from './sync.mjs';
import { CODES } from './failure-codes.mjs';
import { Failure, note, setCapture } from './trace.mjs';

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
let onSessionFrame = null;

/** Let the app show what the agent is doing. Optional: the CLI sets none. */
export function observeSessions({ open, close, frame }) {
  onSessionOpen = open;
  onSessionClose = close;
  onSessionFrame = frame ?? null;
}

/**
 * Hand the app a still of the page, when there is anyone to show it to.
 *
 * Only a conversation's work has a card to put it in: a scheduled sync has
 * nowhere, and the CLI's browser has no view to capture. A capture that
 * fails costs the picture and nothing else.
 */
async function reportFrame(browser) {
  if (!onSessionFrame || !browser?.capture || !showsInChat(browser)) return;
  const frame = await browser.capture();
  if (frame) onSessionFrame(browser, frame);
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
    note('browser.opened', { portalId, shown: showsInChat(session) });
    // A still of the page if this attempt fails, for the debug page.
    setCapture(() => session.capture());
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
  let running = null;
  /**
   * @param {() => Promise<unknown>} fn
   * @param {{ kind?: string, portalId?: string|null }} [label] what this pass is,
   *   so the heartbeat can say what the browser is busy with
   */
  const gate = async (fn, label = {}) => {
    if (running) return false;
    running = {
      kind: label.kind ?? 'work',
      portalId: label.portalId ?? null,
      since: new Date().toISOString(),
    };
    try {
      await fn();
      return true;
    } finally {
      // In a finally, so one failing portal cannot wedge the gate shut and
      // silently stop every poll for the life of the app.
      running = null;
    }
  };
  /** What holds the browser right now, or null. */
  gate.current = () => running;
  return gate;
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
 * Add a site, with its sign-in if it has one of its own.
 *
 * Adding succeeds once the details are kept. Whether a sign-in works is not a
 * question to answer here: a site behind Google has no form this can fill up
 * front, and the agent signs in when it opens the site -- saved sign-in
 * first, Google otherwise.
 */
export function addSite({ name, url, username, password }) {
  const portal = addPortal({ name, url });
  if (!username || !password) return portal;
  try {
    saveCredentials(portal.id, { username, password });
  } catch (error) {
    removePortal(portal.id);
    throw error;
  }
  return portal;
}

/**
 * Try a new site's saved sign-in and read it once, if that works.
 *
 * Run after adding, in the background: a sign-in that does not take here is
 * not a failure to report, only a site the agent will sign into later.
 */
export async function firstSignIn(portalId) {
  const signedIn = await autoSignIn(portalId);
  if (!signedIn.ok) {
    // Nothing saved is nothing to do, not a failure: the agent signs in later.
    if (!signedIn.attempted) return;
    throw new Failure(signedIn.code, signedIn.reason);
  }
  // No second look needed: signing in recorded where the site put us, which
  // is the site.
  const failure = needsLoginFailure(await syncPortal(portalId));
  if (failure) throw failure;
}

/**
 * Whether a page belongs to a connected site, as far as a saved sign-in goes.
 *
 * The site's own host or any subdomain of it, over https. Measured on
 * Studyo: the site is studyo.app and its sign-in form is on
 * accounts.studyo.app, so an exact match refused to fill it. A subdomain is
 * the site's own -- the rule a browser's password manager uses too. A host
 * that merely contains the name is not, nor is the site's parent, nor the
 * site over plain http, where a password would travel in the clear.
 */
export function sameSite(siteOrigin, pageOrigin) {
  let site;
  let page;
  try {
    site = new URL(siteOrigin);
    page = new URL(pageOrigin ?? '');
  } catch {
    // expected: not a URL, so it belongs to no site.
    return false;
  }
  if (site.protocol !== 'https:' || page.protocol !== 'https:') return false;
  const own = site.hostname.toLowerCase();
  const host = page.hostname.toLowerCase();
  return host === own || host.endsWith(`.${own}`);
}

/** Google's sign-in page, where a "sign in with Google" flow ends up. */
export function isGoogleSignIn(origin) {
  try {
    return new URL(origin).origin === 'https://accounts.google.com';
  } catch {
    // expected: not a URL, so not Google's sign-in page.
    return false;
  }
}

/**
 * Which connected site's saved sign-in a page may be filled with, or null.
 *
 * A page on the site's own host or subdomain uses that site's sign-in. The
 * exception is the one the student asked for: a site that signs in through
 * Google sends them to accounts.google.com, and the sign-in they saved for
 * that site is the Google login it wants. So while a connected site's own
 * sign-in is under way -- flowPortalId names it -- a Google sign-in page uses
 * that site's sign-in too. A bare visit to Google, with nothing behind it,
 * gets nothing, and the flow never reaches any other site a page redirects to.
 *
 * @param {string} origin the page asking to be signed in
 * @param {{ id: string, origin: string }[]} portals connected sites
 * @param {string|null} flowPortalId the connected site currently being signed into
 * @returns {string|null} the portal id whose sign-in to use
 */
export function signInPortalFor(origin, portals, flowPortalId) {
  const direct = portals.find((p) => sameSite(p.origin, origin));
  if (direct) return direct.id;
  if (flowPortalId && isGoogleSignIn(origin) && portals.some((p) => p.id === flowPortalId)) {
    return flowPortalId;
  }
  return null;
}

/**
 * The connected site whose sign-in is currently under way, if any.
 *
 * Set while the agent's browsing is on a connected site's own pages, so that
 * when the site hands off to Google the saved sign-in can follow it there --
 * and only there. Never cleared by landing on Google, or the hand-off would
 * clear the very thing it needs; cleared instead when a new conversation's
 * browsing begins somewhere that is not a connected site.
 */
let flowPortal = null;

/** Remember the flow site when a page belongs to one; leave it otherwise. */
function rememberFlow(url) {
  try {
    const origin = new URL(url).origin;
    const site = listPortals().find((p) => sameSite(p.origin, origin));
    if (site) flowPortal = site.id;
  } catch {
    // expected: not a URL we can read; the flow is whatever it already was.
  }
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
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Failure('nav.invalid_url', `"${String(url).slice(0, 200)}" is not a web address.`);
  }
  const site = listPortals().find((p) => sameSite(p.origin, target.origin));
  // Only a name now: every view shares one store, so a page behind a login
  // the student has anywhere in it simply opens. A connected site is called
  // by its name in the conversation, its sign-in host included; anything
  // else by its host.
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
  // A fresh conversation's browsing starts no flow; opening a connected site
  // starts its. This is the only place the flow resets, so it cannot carry
  // from one conversation's sign-in into another's.
  if (!same) flowPortal = site?.id ?? null;
  const browser = same ? resumeBrowser(open) : await openBrowser(label);
  current = browser.view ? browser : null;
  try {
    const { load } = await browser.openPage(target.toString());
    // Give a page that builds itself a moment to do so.
    await new Promise((r) => setTimeout(r, 2500));
    const read = JSON.parse(await evaluate(browser, SNAPSHOT_SCRIPT));
    rememberFlow(read.url);
    await reportFrame(browser);
    await browser.close();
    /*
     * How the load went travels with the page. A site's "Not Found" page is
     * still a page, and readable -- but an agent told only "here is the page"
     * reads a 404 as the answer it was looking for.
     */
    return {
      ...read,
      ...(typeof load?.status === 'number' ? { httpStatus: load.status } : {}),
      ...(load?.timedOut ? { stillLoading: true } : {}),
    };
  } catch (error) {
    await browser.close().catch((e) => note('browser.close_failed', { error: e.message }));
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
    note('act.no_page', {
      open: Boolean(page),
      shown: Boolean(page && showsInChat(page)),
      sameConversation: Boolean(page && page.agentId === workingForAgent),
    });
    throw new Failure('page.no_page_open');
  }
  const browser = resumeBrowser(page);
  try {
    const read = await performAction(browser, action, {
      /*
       * The keychain, asked from here for the page's own site, or -- while
       * that site's sign-in is under way -- for the Google page it hands off
       * to. A saved sign-in reaches its own site and that site's Google step,
       * and nowhere else, and the answer never leaves this process.
       */
      credentialsFor: (origin) => {
        const id = signInPortalFor(origin, listPortals(), flowPortal);
        return id ? readCredentials(id) : null;
      },
    });
    rememberFlow(read?.url);
    await reportFrame(browser);
    await browser.close();
    return read;
  } catch (error) {
    await browser.close().catch((e) => note('browser.close_failed', { error: e.message }));
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
export async function autoSignIn(portalId, { saved: known } = {}) {
  const portal = listPortals().find((p) => p.id === portalId);
  if (!portal) throw new Failure('sync.unknown_site', `There is no site called ${portalId}.`);

  // Handed in by a sync that already read it, so the keychain asks once.
  const saved = known ?? readCredentials(portalId);
  if (!saved) {
    note('auto_sign_in.no_credentials', { portalId });
    return {
      attempted: false,
      ok: false,
      code: 'signin.no_credentials',
      reason: 'no saved sign-in',
    };
  }

  const browser = await openBrowser(portalId);
  try {
    const { sessionId } = await browser.openPage(portal.url);
    await new Promise((r) => setTimeout(r, 1500));

    const filled = await evaluate(browser, fillScript(saved.username, saved.password), sessionId);
    note('auto_sign_in.filled', { result: filled });
    if (filled !== 'submitted') {
      await browser.close();
      return { attempted: true, ok: false, code: 'signin.stuck', reason: explainFailure(filled) };
    }

    // Let the sign-in land, then ask the same question a person would: are we
    // still looking at a password box?
    await new Promise((r) => setTimeout(r, 4000));
    const { stillAsking, landed } = JSON.parse(await evaluate(browser, INSPECT_SCRIPT, sessionId));
    note('auto_sign_in.landed', { stillAsking, landed });
    await browser.close();

    if (stillAsking) {
      return {
        attempted: true,
        ok: false,
        code: 'signin.rejected',
        reason: 'still asking for a password',
      };
    }

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
  } catch (error) {
    await browser.close().catch((e) => note('browser.close_failed', { error: e.message }));
    /*
     * The error's own words go to the trace, never back to a caller: they can
     * carry the page's text, and a rejected sign-in page is exactly where a
     * typed password gets echoed back. The trace is safe because the password
     * was registered as a secret when it was read, and is blanked there.
     */
    const code = error instanceof Failure ? error.code : 'internal.unexpected';
    note('auto_sign_in.failed', { code, error: String(error?.message ?? error) });
    return {
      attempted: true,
      ok: false,
      code,
      reason: error instanceof Failure ? error.message : CODES[code],
    };
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
  // A second caller joins the run already going; its trace says so, since
  // the steps all belong to the first.
  if (inFlight.has(portalId)) note('sync.joined_running', { portalId });
  return coalesce(inFlight, portalId, () => runSync(portalId, options));
}

async function runSync(portalId, { budget = 40, retried = false } = {}) {
  const config = readConfig();
  if (!config.token) throw new Failure('sync.not_linked');
  const portal = (config.portals ?? []).find((p) => p.id === portalId);
  if (!portal) throw new Failure('sync.unknown_site', `There is no site called ${portalId}.`);

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
  // Read once per sync: each read can be a keychain prompt, and a refused one
  // must not stop a crawl whose session still works.
  const keychain = savedSignIn(portalId);
  let recovery = null;
  if (!portal.loggedInAt && keychain.creds) {
    recovery = await autoSignIn(portalId, { saved: keychain.creds });
    note('sync.signed_in_first', { ok: recovery.ok, code: recovery.code ?? null });
    if (recovery.ok) portal.loggedInAt = new Date().toISOString();
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

    note('sync.read', {
      pages: map.pagesVisited,
      complete: map.complete,
      needsLogin: map.needsLogin,
      loginWhy: map.loginWhy ?? null,
    });
    try {
      await pushSnapshot(
        { apiBase: config.apiBase ?? 'https://contextoagent.ai', token: config.token },
        { portalId, origin: portal.origin, map, redacted: map.redacted },
      );
    } catch (error) {
      if (error instanceof DeviceUnlinked) throw error;
      throw new Failure('sync.push_failed', undefined, { error: String(error?.message ?? error) });
    }

    /*
     * The crawl found a sign-in page. If there is a saved sign-in, use it and
     * look again -- once. Reporting an empty site when the means to fix it is
     * sitting in the keychain is the wrong answer.
     */
    if (map.needsLogin && !retried && keychain.creds) {
      await browser.close();
      recovery = await autoSignIn(portalId, { saved: keychain.creds });
      note('sync.signed_in_again', { ok: recovery.ok, code: recovery.code ?? null });
      if (recovery.ok) return runSync(portalId, { budget, retried: true });
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
    if (map.needsLogin) {
      result.login = {
        why: map.loginWhy ?? null,
        saved: Boolean(keychain.creds),
        keychain: keychain.refused,
        recovery: recovery
          ? { ok: recovery.ok, code: recovery.code, reason: recovery.reason }
          : null,
      };
    }
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
    await browser.close().catch((e) => note('browser.close_failed', { error: e.message }));

    if (error instanceof DeviceUnlinked) {
      // Someone unlinked this computer from the web app. Dropping the token
      // returns the window to "Link this computer", which is the only thing
      // that helps; keeping it would retry every six hours forever.
      forgetDevice();
      throw new Failure('sync.device_unlinked');
    }
    updatePortal(portalId, { lastError: String(error.message ?? error) });
    throw error;
  }
}
