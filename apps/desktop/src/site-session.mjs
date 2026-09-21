import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebContentsView, app, session } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * One store for everything the agent's browser does, the way a Chrome profile
 * is one store. A site signed into stays signed in, and Sign in with Google
 * carries from one site to the next -- which a partition per site could never
 * do, since Google's cookies sat in whichever site's jar the sign-in happened
 * in. The label a conversation shows is still the site's; only the store is
 * shared.
 */
export const SHARED_PARTITION = 'persist:school';

/**
 * A user agent Google's sign-in page will accept.
 *
 * Google answers a browser that names itself Electron with "This browser or
 * app may not be secure" and stops there. The rest of Electron's default
 * string is an ordinary Chrome on this OS, so the two tokens that give it
 * away -- Electron's own, and the embedding app's -- come out, and nothing
 * else changes. Not a spoof: what is left is true.
 */
export function userAgentFor(fallback) {
  return fallback
    .replace(/\s(?:Electron|ContextoAgent)\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * A browser the agent drives, inside the app.
 *
 * Replaces spawning the student's Chrome. Two reasons that is better here:
 * the student can watch it work, which matters when the thing being watched
 * is signing into their school account; and there is no second application
 * appearing on their dock, opening tabs, or fighting over a profile
 * directory.
 *
 * Every session shares one persistent store, SHARED_PARTITION, so a sign-in
 * survives restarts and carries across sites the way it does in a browser
 * profile. The portalId is what the conversation calls it, not where its
 * cookies live.
 *
 * The explorer is unchanged: this presents the same small surface it already
 * expected -- cdp.send, cdp.on, navigate -- backed by webContents.debugger
 * rather than a pipe to another process.
 */
export class SiteSession {
  /** @param {{ portalId: string, agentId?: string|null }} options */
  constructor({ portalId, agentId = null }) {
    this.portalId = portalId;
    /** Which conversation this belongs to, or null for a scheduled sync. */
    this.agentId = agentId;
    /** Set by whoever is showing it, to keep the page up after the work ends. */
    this.keepView = false;
    this.view = null;
    this.attached = false;
    this.listeners = new Map();
  }

  get webContents() {
    return this.view?.webContents ?? null;
  }

  async launch() {
    /*
     * Before the view exists: a session's user agent applies only to contents
     * created after it is set, so setting it afterwards leaves the page
     * announcing Electron. Setting it on the contents as well covers the view
     * whatever order Electron settles on.
     */
    const ua = userAgentFor(app.userAgentFallback);
    session.fromPartition(SHARED_PARTITION).setUserAgent(ua);
    this.view = new WebContentsView({
      webPreferences: {
        /*
         * The site is untrusted content and is treated as such: its own store,
         * no node, an isolated world. The preload exposes nothing to the page
         * -- it only reports that the student clicked, which is what lets the
         * whole view act as one button rather than needing a strip along the
         * top to press.
         */
        preload: join(here, 'site-view-preload.cjs'),
        partition: SHARED_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const wc = this.webContents;
    wc.setUserAgent(ua);
    /*
     * A link that wants a new window opens here instead. There is one view
     * per session, and it is the one the student is watching; a page that
     * appeared in a window of its own would be neither.
     */
    wc.setWindowOpenHandler(({ url }) => {
      void wc.loadURL(url);
      return { action: 'deny' };
    });
    // Once, for the life of the view. Attaching again later must not add a
    // second copy, or every event would be handled twice.
    wc.debugger.on('message', (_event, method, params) => {
      for (const handler of this.listeners.get(method) ?? []) handler(params);
    });
    this.attach();
    return this;
  }

  /**
   * Take the protocol connection back on a page that was left open.
   *
   * The page stays on screen after the agent's step ends, released rather
   * than closed, so the next step can pick it up where it was left -- a
   * click, then a look, then typing, all on the one page the student is
   * watching. Nothing to do if it is already held.
   */
  attach() {
    const wc = this.webContents;
    if (!wc) throw new Error('This session is not open.');
    if (this.attached) return;
    wc.debugger.attach('1.3');
    this.attached = true;

    this.cdp = {
      send: async (method, params = {}) => wc.debugger.sendCommand(method, params),
      on: (method, handler) => {
        const list = this.listeners.get(method) ?? [];
        list.push(handler);
        this.listeners.set(method, list);
        return () => {
          const remaining = (this.listeners.get(method) ?? []).filter((h) => h !== handler);
          this.listeners.set(method, remaining);
        };
      },
    };
  }

  /** Matches the shape the explorer already calls. */
  async openPage(url) {
    await this.navigate(url);
    return { sessionId: null };
  }

  /**
   * Navigate and wait for the page to settle.
   *
   * did-finish-load rather than a timer, with a timer as the backstop: a
   * portal that never finishes loading must not hang the whole sync.
   */
  async navigate(url, _sessionId, { timeoutMs = 30_000 } = {}) {
    const wc = this.webContents;
    if (!wc) throw new Error('This session is not open.');

    const settled = new Promise((resolve) => {
      const done = () => {
        wc.off('did-finish-load', done);
        wc.off('did-fail-load', done);
        resolve(true);
      };
      wc.once('did-finish-load', done);
      wc.once('did-fail-load', done);
    });

    await wc.loadURL(url).catch(() => {});
    return Promise.race([settled, new Promise((r) => setTimeout(() => r(false), timeoutMs))]);
  }

  /** Read something out of the page. */
  async evaluate(expression) {
    const { result } = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.value;
  }

  /**
   * Finish with the page, and usually leave it on screen.
   *
   * The last thing the agent looked at is worth keeping: a browser that
   * vanishes the moment it stops takes the evidence with it, and "what did it
   * actually read" is a fair question after the fact as well as during. The
   * protocol connection is always released -- nothing is driving it any more
   * -- but the view stays until something replaces it, or the agent's next
   * step attaches to it again.
   */
  async close() {
    if (!this.view) return;
    try {
      if (this.attached) this.webContents?.debugger.detach();
    } catch {
      // Already detached, or the view is gone. Either way there is nothing
      // left to release.
    }
    this.attached = false;
    this.cdp = null;
    this.listeners.clear();

    if (this.keepView) return;
    this.destroy();
  }

  /** Actually take it down. */
  destroy() {
    try {
      this.view?.webContents?.close();
    } catch {
      // Already gone.
    }
    this.view = null;
  }
}
