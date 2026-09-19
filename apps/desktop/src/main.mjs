import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, session, shell, Tray } from 'electron';
import {
  link,
  pendingWork,
  readConfig,
  refreshSession,
  reportWork,
  sessionValid,
} from './sync.mjs';
import {
  clearCredentials,
  hasCredentials,
  keychainAvailable,
  saveCredentials,
} from './credentials.mjs';
import {
  actOnPage,
  autoSignIn,
  addSiteWithSignIn,
  observeSessions,
  browsePage,
  oneAtATime,
  setWorkingForAgent,
  removePortal,
  status,
  syncPortal,
} from './operations.mjs';
import { ActionError } from './page-actions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env['CONTEXTO_API'] ?? 'https://contextoagent.ai';
const WEB_BASE = process.env['CONTEXTO_WEB'] ?? 'https://contextoagent.ai';

/** Six hours. Coursework changes over days, not minutes. */
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How stale a portal has to be before opening the app refreshes it.
 *
 * Without a start-up sync, a laptop that was shut for a week shows week-old
 * coursework until the first interval fires. With an unconditional one, every
 * quit-and-reopen spawns a browser and re-reads the whole portal.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * How often to ask whether the agent needs something fetched.
 *
 * Three seconds, because the agent now waits for the answer instead of
 * promising one. A minute of that wait spent before the work even starts is a
 * minute of the student watching nothing happen.
 *
 * It is a poll because the work happens on a machine that reaches out to us
 * and cannot be reached back. A tiny request every few seconds is cheaper
 * than the machinery that would avoid it, and it stops entirely when nothing
 * is linked.
 */
const WORK_POLL_MS = 3 * 1000;

let mainWindow = null;
let tray = null;
let syncing = false;

/*
 * One browser-driving pass at a time, across both loops.
 *
 * The scheduled sync and the work poll each open browsers, and between them
 * they share every piece of state that decides where a browser goes: the
 * active session, the bounds it is drawn at, and which conversation it
 * belongs to. Overlapping passes were the cause rather than a symptom -- a
 * poll firing every three seconds picked up work that was still running, and
 * the browser it opened destroyed the one halfway through reading a page, so
 * the request the student was waiting on failed while its replacement quietly
 * succeeded behind it.
 */
const drivingBrowser = oneAtATime();

/**
 * One window, two states.
 *
 * Connect this device first; after that the app IS the web app -- the same
 * pages a browser shows, because a second implementation of them would be two
 * things to keep in step. What the desktop adds is handed to that page by a
 * preload: inside the app the Sites section can add and sign into a site,
 * because there is a real browser here to drive it.
 *
 * A preload is fixed when a window is created, so linking rebuilds the
 * window rather than swapping its contents. That happens once.
 */
function showWindow() {
  const linked = status().linked;

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.showingApp === linked) {
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    // destroy() does not raise 'close', so the browser is rescued by hand.
    detachSiteView();
    mainWindow.destroy();
  }

  mainWindow = new BrowserWindow({
    width: linked ? 1100 : 760,
    height: linked ? 820 : 660,
    title: 'Contexto Agent',
    webPreferences: {
      preload: join(here, linked ? 'web-preload.cjs' : 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.showingApp = linked;

  if (linked) void mainWindow.loadURL(WEB_BASE);
  else void mainWindow.loadFile(join(here, 'renderer', 'index.html'));

  /*
   * Put the browser back if one was open when the last window went. It stays
   * hidden until the conversation says where it goes, which is the same rule
   * as when it first appeared.
   */
  if (activeSession?.view) {
    mainWindow.contentView.addChildView(activeSession.view);
    applySiteViewBounds();
  }

  /*
   * Sign-in has to stay inside this window.
   *
   * Google's OAuth redirect is how the app gets its session; sending it to the
   * system browser would leave the session there and the app permanently
   * signed out. Only genuinely third-party links go outside, where there is an
   * address bar to check them against.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return '';
      }
    })();
    if (url.startsWith(WEB_BASE) || host === 'accounts.google.com') return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  /*
   * Take the browser out of the window before the window goes.
   *
   * A view destroyed along with its window takes the page the agent ended on
   * with it, so closing the app and coming back left an empty conversation
   * where the evidence had been. Detached first, it outlives the window and
   * goes back into the next one -- verified: the page, its title and its
   * contents are all still there afterwards.
   */
  mainWindow.on('close', () => detachSiteView());

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Whatever the panel last reported was measured inside a window that no
    // longer exists. The next one will say where it goes.
    siteViewBounds = null;
  });
}

/**
 * The menu bar item, which is what the app mostly is.
 *
 * This is a sync utility -- it should be running whether or not a window is
 * open, and closing the window should not stop portals being read. Without a
 * tray, quitting the window would either kill the sync or leave the app alive
 * with nothing on screen to show for it.
 */
function buildTray() {
  tray = new Tray(join(here, 'assets', 'tray.png'));
  tray.setToolTip('Contexto Agent');
  refreshTrayMenu();
  tray.on('click', () => showWindow());
}

function refreshTrayMenu() {
  if (!tray) return;
  const { linked, portals } = status();
  const synced = portals
    .map((p) => p.lastSyncedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: !linked
          ? 'Not linked to an account'
          : synced
            ? `Last synced ${new Date(synced).toLocaleString()}`
            : 'Never synced',
        enabled: false,
      },
      { type: 'separator' },
      { label: 'Open Contexto Agent', click: () => showWindow() },
      {
        label: syncing ? 'Syncing…' : 'Sync now',
        // Nothing to sync without a linked account or a signed-in portal, and
        // an enabled item that silently does nothing reads as a broken app.
        enabled: linked && !syncing && portals.some((p) => p.loggedInAt),
        click: () => void syncAll(),
      },
      { type: 'separator' },
      { label: 'Quit Contexto Agent', click: () => app.quit() },
    ]),
  );
}

/** Wrap a handler so a thrown error reaches the renderer as a message. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const value = await fn(...args);
      // The menu bar reflects config the renderer just changed. Only the menu
      // is refreshed here -- pushing an event back at the window that made the
      // call would loop it through its own re-render.
      refreshTrayMenu();
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });
}

handle('status', () => ({
  ...status(),
  // Electron-specific, so it is read here rather than from the config file --
  // the operating system is the source of truth for this, not us.
  openAtLogin: app.getLoginItemSettings().openAtLogin,
}));
handle('setOpenAtLogin', (value) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(value), openAsHidden: true });
  return app.getLoginItemSettings().openAtLogin;
});
handle('link', async () => {
  const device = await link({ apiBase: API_BASE, webBase: WEB_BASE });
  // Linking changes which preload the window needs, so the window is rebuilt.
  // On the next tick, so this call's reply reaches the window that made it.
  setTimeout(() => showWindow(), 50);
  return device;
});
/**
 * Sign in, from inside the app.
 *
 * Two ways, cheapest first. A device that is already linked needs no browser
 * and no Google at all -- it can exchange its link for a session, which is
 * the same question already answered at linking time.
 *
 * Only when that fails does a browser open, and it is the student's own
 * browser rather than a window inside this app: it is where they are already
 * signed in, and it has an address bar to check Google's page against.
 */
handle('signIn', async () => {
  const config = readConfig();
  const apiBase = config.apiBase ?? API_BASE;

  if (config.token) {
    try {
      await refreshSession({ apiBase, token: config.token });
      reloadApp();
      return { via: 'device' };
    } catch {
      // Device revoked or offline; fall through to linking again.
    }
  }

  const device = await link({ apiBase, webBase: WEB_BASE });
  setTimeout(() => showWindow(), 50);
  return { via: 'browser', device };
});

handle('addPortal', (site) => addSiteWithSignIn(site));
handle('removePortal', (id) => removePortal(id));
handle('syncPortal', (id) => syncPortal(id));

/*
 * Saved sign-ins. The password crosses this boundary once, on its way to the
 * keychain, and never comes back out -- hasCredentials answers yes or no, and
 * nothing returns the value itself to a window.
 */
handle('saveCredentials', (id, creds) => saveCredentials(id, creds));
handle('hasCredentials', (id) => ({ saved: hasCredentials(id), available: keychainAvailable() }));
handle('clearCredentials', (id) => clearCredentials(id));
handle('autoSignIn', (id) => autoSignIn(id));

/*
 * The page reporting where its frame is. Sent on every layout change --
 * expanding, resizing, scrolling -- because a native view does not move with
 * the document and would otherwise sit where the frame used to be.
 */
/*
 * What is on screen right now, asked rather than waited for.
 *
 * Events alone lose the browser the moment a student leaves the conversation
 * and comes back -- the panel remounts having missed the message that said it
 * was there. Asking on mount is what makes it stay put.
 */
handle('siteSession', () => ({
  active: Boolean(activeSession?.working),
  showing: Boolean(activeSession?.view),
  portalId: activeSession?.portalId ?? null,
  agentId: activeSession?.agentId ?? null,
}));

handle('siteViewBounds', (bounds) => {
  siteViewBounds = bounds
    ? {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
      }
    : null;
  applySiteViewBounds();
  return { ok: true };
});

/**
 * Sync everything that has a session, quietly.
 *
 * Failures are swallowed on purpose: a portal that is down, or a login that
 * expired, must not stop the others or throw a dialog at someone who did not
 * ask for one. The window shows the last error per portal instead.
 */
async function syncAll({ onlyStale = false } = {}) {
  return drivingBrowser(() => syncAllPass({ onlyStale }));
}

async function syncAllPass({ onlyStale }) {
  syncing = true;
  refreshTrayMenu();
  for (const portal of status().portals) {
    // No session means the only useful action is signing in, which needs the
    // student. Syncing would just record the same failure again.
    if (!portal.loggedInAt) continue;
    if (onlyStale && portal.lastSyncedAt) {
      const age = Date.now() - new Date(portal.lastSyncedAt).getTime();
      if (age < STALE_AFTER_MS) continue;
    }
    try {
      await syncPortal(portal.id);
    } catch {
      /* recorded against the portal by syncPortal */
    }
    // Per portal rather than at the end, so a slow second portal does not hold
    // back the result of the first.
    notifyChanged();
  }
  syncing = false;
  refreshTrayMenu();
}

/**
 * Reload the hosted app so a new session takes effect.
 *
 * The session travels as a request header, so pages already rendered keep
 * using whatever they loaded with. Without this the student signs in
 * successfully and stares at the signed-out screen.
 */
function reloadApp() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
}

/**
 * Do what the agent asked, using a sign-in that never leaves this machine.
 *
 * This is the inversion that lets the agent reach a site without the server
 * ever holding the means to: it can leave a request, and only the computer
 * with the keychain entry can act on it.
 */
async function doPendingWork() {
  const config = readConfig();
  if (!config.token) return;
  const creds = { apiBase: config.apiBase ?? API_BASE, token: config.token };

  let work;
  try {
    work = await pendingWork(creds);
  } catch {
    return; // Offline, or the device was revoked. Nothing to do either way.
  }

  for (const item of work) {
    let outcome;
    let result;
    try {
      // Tagging the work means its browser appears in the conversation that
      // asked for it, rather than floating over whatever the student is
      // looking at.
      setWorkingForAgent(item.agentId);
      if (item.kind === 'browse') {
        result = await browsePage(item.targetUrl);
        outcome = 'read';
      } else if (item.kind === 'act') {
        result = await actOnPage(item.payload ?? {});
        outcome = 'read';
      } else {
        const synced = await syncPortal(item.portalId);
        outcome = synced.needsLogin ? 'needs_login' : 'synced';
      }
    } catch (error) {
      outcome = 'failed';
      // Only a reason this app wrote itself travels back. Anything else could
      // be carrying the page's own words, and the page is not to be trusted.
      if (error instanceof ActionError) result = { reason: error.message };
    }
    setWorkingForAgent(null);
    await reportWork(creds, item.id, outcome, result).catch(() => {});
    notifyChanged();
  }
}

/**
 * The browser the agent is driving, shown inside the app.
 *
 * A native view cannot be given a CSS glow, so the page draws the frame and
 * this positions the view inside the hole it leaves. The page owns where it
 * goes and how big it is; this owns what is in it. That split is why the
 * student can expand it, drag the window, or scroll, and the view stays put
 * without any of that logic living out here.
 */
let activeSession = null;
let siteViewBounds = null;

/*
 * A click anywhere on the browser reaches the page it belongs to. The site
 * itself cannot send this -- only the preload can -- so a page cannot make
 * the panel open or close by itself.
 */
ipcMain.on('site-view-clicked', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('site-view-clicked');
});

function attachSiteView(session) {
  if (!mainWindow || mainWindow.isDestroyed() || !session?.view) return;

  // Whatever was left on screen from last time makes way for this.
  if (activeSession && activeSession !== session) {
    mainWindow.contentView.removeChildView(activeSession.view);
    activeSession.destroy();
  }

  // Kept after the work finishes: the page the agent ended on is the evidence
  // of what it did, and it should not disappear with the spinner.
  session.keepView = true;
  session.working = true;
  activeSession = session;
  mainWindow.contentView.addChildView(session.view);
  applySiteViewBounds();
  mainWindow.webContents.send('site-session', {
    active: true,
    portalId: session.portalId,
    agentId: session.agentId,
  });
}

/** Lift the browser out of the window without ending the session. */
function detachSiteView() {
  if (!activeSession?.view || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.contentView.removeChildView(activeSession.view);
  } catch {
    // The window is already tearing down; the view goes with it either way.
  }
}

function applySiteViewBounds() {
  if (!activeSession?.view) return;
  /*
   * Hidden until the page says where it goes, rather than parked off-screen
   * as a ten-pixel sliver. The sliver still counted as showing, so a missing
   * bounds report looked like a browser that had loaded nothing -- an empty
   * box, which is worse than no box.
   */
  if (!siteViewBounds) {
    activeSession.view.setVisible(false);
    return;
  }
  activeSession.view.setVisible(true);
  activeSession.view.setBounds(siteViewBounds);
}

/**
 * The work is done, but the page stays.
 *
 * Only the state changes: the conversation stops showing it as working, and
 * the aura goes with that. The browser itself remains until the next piece of
 * work replaces it, or the window closes.
 */
function markSiteViewIdle() {
  if (activeSession) activeSession.working = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('site-session', {
    active: false,
    showing: Boolean(activeSession?.view),
    portalId: activeSession?.portalId,
    agentId: activeSession?.agentId,
  });
}

/** Keep the window and the menu bar showing the same thing. */
function notifyChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('portals-changed');
  refreshTrayMenu();
}

/**
 * Carry the session the link gave us into every request the page makes.
 *
 * A bearer header rather than a cookie: Better Auth signs its session cookie,
 * so writing one from here would mean reproducing that signature and keeping
 * it right forever. The bearer plugin is already enabled for exactly this,
 * and reads the same session.
 *
 * Scoped to our own origin -- an Authorization header is a credential, and it
 * has no business travelling anywhere else.
 */
function attachSession() {
  const origin = new URL(WEB_BASE).origin;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const token = readConfig().sessionToken;
    if (!token || !details.url.startsWith(origin)) return callback({});
    callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` } });
  });
}

/**
 * A linked device with no session gets one before the window opens.
 *
 * Otherwise the app loads the web app signed out, and the only way back in
 * looks like signing into Google again -- which is exactly the second
 * question linking exists to avoid.
 */
async function ensureSession() {
  const config = readConfig();
  if (!config.token) return;

  const apiBase = config.apiBase ?? API_BASE;
  // Checked, not merely present: a session that expired while the app was
  // closed looks identical to a working one from here, and treating it as
  // good is how an app ends up permanently signed out with no way back.
  if (await sessionValid({ apiBase, sessionToken: config.sessionToken })) return;

  try {
    await refreshSession({ apiBase, token: config.token });
  } catch {
    // A revoked device or an offline start. The window still opens; the web
    // app will ask for a sign-in, which is the honest outcome either way.
  }
}

/*
 * One copy at a time.
 *
 * Two copies of the app -- one in Applications, one wherever a build or a
 * mounted installer left it -- each open a window, each poll for work, and
 * each put a browser on screen, and the student sees two of everything with
 * no way to tell which is which. The second to start hands over to the first
 * and quits, and the first comes to the front, which is what opening it
 * meant.
 */
const onlyCopy = app.requestSingleInstanceLock();
if (!onlyCopy) app.quit();
app.on('second-instance', () => showWindow());

void app.whenReady().then(async () => {
  if (!onlyCopy) return;
  observeSessions({ open: attachSiteView, close: markSiteViewIdle });
  attachSession();
  await ensureSession();
  showWindow();
  buildTray();
  void syncAll({ onlyStale: true });
  setInterval(() => void syncAll(), SYNC_INTERVAL_MS);
  setInterval(() => void drivingBrowser(doPendingWork), WORK_POLL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showWindow();
  });
});

/*
 * Closing the window leaves the app running in the menu bar, on every
 * platform. That is the point of a sync utility: a student who closes the
 * window still expects their coursework to keep arriving. Quit is in the tray
 * menu, where someone looking to stop it will look.
 */
app.on('window-all-closed', () => {});
