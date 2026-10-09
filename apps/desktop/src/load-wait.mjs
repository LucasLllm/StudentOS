/**
 * Waiting for a page to load, and saying how it ended.
 *
 * Three endings: it loaded (with the address it ended on and the HTTP status),
 * it failed (a coded Failure, with the reason Chromium gave), or it ran out of
 * time (said so, with where it had got to -- the page may still be readable,
 * so that one is the caller's to judge).
 *
 * Kept apart from site-session.mjs so it can be tested without Electron; all
 * it needs is something that emits Electron's webContents load events.
 */

import { Failure, bound, note } from './trace.mjs';

/**
 * Chromium's network error numbers, as failure codes.
 * The full list is net/base/net_error_list.h.
 */
export function codeForNetError(error) {
  if (error === -105 || error === -137) return 'nav.dns'; // NAME_NOT_RESOLVED, NAME_RESOLUTION_FAILED
  if (error === -106) return 'nav.offline'; // INTERNET_DISCONNECTED
  if (error === -7 || error === -118) {
    return error === -7 ? 'nav.timeout' : 'nav.connection'; // TIMED_OUT, CONNECTION_TIMED_OUT
  }
  if (error <= -100 && error > -200) return 'nav.connection';
  if (error <= -200 && error > -300) return 'nav.cert';
  if (error === -20 || error === -21 || error === -301) return 'nav.blocked'; // BLOCKED_BY_CLIENT/ADMIN, DISALLOWED_URL_SCHEME
  return 'nav.failed';
}

/**
 * The same, from the name Chrome's protocol gives (Page.navigate's errorText).
 * Null for ERR_ABORTED, which is a load being replaced rather than failing.
 */
export function codeForNetErrorName(name) {
  const n = String(name ?? '').replace(/^net::/, '');
  if (n === 'ERR_ABORTED') return null;
  if (n === 'ERR_NAME_NOT_RESOLVED' || n === 'ERR_NAME_RESOLUTION_FAILED') return 'nav.dns';
  if (n === 'ERR_INTERNET_DISCONNECTED') return 'nav.offline';
  if (n === 'ERR_TIMED_OUT') return 'nav.timeout';
  if (/^ERR_CERT_|^ERR_SSL_/.test(n)) return 'nav.cert';
  if (/^ERR_BLOCKED_|^ERR_DISALLOWED_/.test(n)) return 'nav.blocked';
  if (/^ERR_(CONNECTION|ADDRESS|NETWORK|TUNNEL|PROXY)_/.test(n)) return 'nav.connection';
  return 'nav.failed';
}

/** ERR_ABORTED: the load was replaced -- a redirect, or a download -- not a failure. */
const ABORTED = -3;

/**
 * @param {import('node:events').EventEmitter & { getURL(): string }} wc
 * @returns {Promise<{ ok: true, url: string, status: number|null } |
 *   { ok: false, timedOut: true, url: string }>}
 */
export function waitForLoad(wc, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let status = null;
    const started = Date.now();

    const navigated = bound((_event, url, code) => {
      status = code ?? null;
      note('nav.response', { url, status });
    });
    const finished = bound(() => {
      stop();
      resolve({ ok: true, url: wc.getURL(), status });
    });
    const failed = bound((_event, error, description, url, isMainFrame) => {
      if (!isMainFrame) {
        note('nav.subframe_failed', { netError: error, description, url });
        return;
      }
      if (error === ABORTED) {
        note('nav.aborted', { url });
        return;
      }
      stop();
      reject(new Failure(codeForNetError(error), undefined, { netError: error, description, url }));
    });
    const timer = setTimeout(
      bound(() => {
        stop();
        const url = wc.getURL();
        note('nav.timeout', { url, afterMs: Date.now() - started });
        resolve({ ok: false, timedOut: true, url });
      }),
      timeoutMs,
    );

    function stop() {
      clearTimeout(timer);
      wc.off('did-navigate', navigated);
      wc.off('did-finish-load', finished);
      wc.off('did-fail-load', failed);
    }

    wc.on('did-navigate', navigated);
    wc.on('did-finish-load', finished);
    wc.on('did-fail-load', failed);
  });
}
