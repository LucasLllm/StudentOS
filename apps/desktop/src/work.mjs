/**
 * One piece of the agent's work, done and described.
 *
 * Kept out of main.mjs so it can be tested without Electron: this is where an
 * attempt's outcome becomes what the server -- and so the agent -- is told.
 * Every failure carries a code and a reason this app wrote, plus the id of the
 * trace that explains it in full.
 */

import { Failure, attempt } from './trace.mjs';
import { logEvent } from './trace-store.mjs';

const KIND = { browse: 'browse', act: 'act' };

/**
 * @param {{ id: string, kind: string, portalId?: string, targetUrl?: string, payload?: object }} item
 * @param {{ browsePage: Function, actOnPage: Function, syncPortal: Function }} ops
 * @returns {Promise<{ outcome: 'read'|'synced'|'needs_login'|'failed', result?: object, record: object }>}
 */
export async function runWorkItem(item, ops) {
  const kind = KIND[item.kind] ?? 'sync';
  const done = await attempt(
    {
      kind,
      requestId: item.id,
      portalId: item.portalId || null,
      target: item.targetUrl ?? (item.payload?.action ? `action:${item.payload.action}` : null),
    },
    async () => {
      if (kind === 'browse') return ops.browsePage(item.targetUrl);
      if (kind === 'act') return ops.actOnPage(item.payload ?? {});
      const synced = await ops.syncPortal(item.portalId);
      if (synced?.needsLogin) {
        throw new Failure('sync.needs_login', whyLogin(synced.login), synced.login ?? {});
      }
      return synced;
    },
  );

  if (done.ok) {
    return kind === 'sync'
      ? { outcome: 'synced', record: done.record }
      : { outcome: 'read', result: done.value, record: done.record };
  }
  return {
    outcome: done.code === 'sync.needs_login' ? 'needs_login' : 'failed',
    result: { code: done.code, reason: done.message, attemptId: done.record.id },
    record: done.record,
  };
}

/** Why a site still wanted a sign-in, from what the sync recorded. */
function whyLogin(login) {
  const where = login?.why === 'off_origin' ? 'sent us to a sign-in page' : 'showed a password box';
  if (!login?.saved) {
    return `The site ${where}, and there is no saved sign-in for it on this computer.`;
  }
  if (login.recovery && !login.recovery.ok) {
    return `The site ${where}. The saved sign-in was tried and failed: ${login.recovery.reason}.`;
  }
  return `The site ${where} again even after signing in with the saved sign-in.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a report, trying again on failure.
 *
 * The agent is waiting on this one request; losing it to a single dropped
 * packet makes the agent tell the student their computer is asleep while the
 * page sits there, opened. Three tries a few seconds apart cover a blip.
 *
 * @returns {Promise<{ sent: true, tries: number } | { sent: false, tries: number, error: string }>}
 */
export async function reportWithRetry(send, { delays = [1000, 3000] } = {}) {
  let lastError;
  for (let tries = 1; tries <= delays.length + 1; tries += 1) {
    try {
      await send();
      return { sent: true, tries };
    } catch (error) {
      // expected: the caller learns of it from the result and logs it once.
      lastError = String(error?.message ?? error);
    }
    if (tries <= delays.length) await sleep(delays[tries - 1]);
  }
  return { sent: false, tries: delays.length + 1, error: lastError };
}

/**
 * Run something through the one-browser gate, and log it when it is turned
 * away. A pass the gate refused used to vanish without a trace, which is how a
 * first sign-in or a scheduled sync could silently never happen.
 *
 * @returns {Promise<boolean>} whether it ran
 */
export async function throughGate(gate, fn, label, what) {
  const ran = await gate(fn, label);
  if (!ran) {
    logEvent('transport.busy', `Skipped ${what}: the browser was busy.`, {
      ...label,
      busy: gate.current?.() ?? null,
    });
  }
  return ran;
}
