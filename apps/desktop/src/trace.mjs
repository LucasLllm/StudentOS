/**
 * What happened, step by step, every time the app drives a browser.
 *
 * One piece of work -- opening a page, a click, a sign-in, a sync -- is one
 * attempt, and every attempt ends in exactly one outcome: ok, or failed with a
 * code from failure-codes.mjs. Along the way anything can note() a step, and
 * the steps are what turn "it failed" into "it failed because the second page
 * still asked for a password after we pressed Next".
 *
 * The current attempt is carried by AsyncLocalStorage rather than passed
 * around, so code deep in a sign-in can record what it saw without every
 * function between here and there growing a parameter for it.
 *
 * Two promises the rest of the app relies on:
 *  - An attempt always ends with an outcome. Code that forgets to say is
 *    recorded as internal.no_outcome, so even a bug in the diagnostics shows.
 *  - Nothing secret is written. Typed text is kept as a length, and any string
 *    registered with secret() is blanked wherever it turns up -- including in
 *    an error message that quotes the script it came from.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { CODES } from './failure-codes.mjs';

/** A failure this app understands, with a code from the closed list. */
export class Failure extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} [message] what to tell the agent; the code's sentence otherwise
   * @param {object} [detail] what to keep in the trace, never sent to the agent
   */
  constructor(code, message, detail = {}) {
    if (!Object.hasOwn(CODES, code)) {
      throw new Error(`"${code}" is not a failure code. Add it to failure-codes.mjs.`);
    }
    super(message || CODES[code]);
    this.name = 'Failure';
    this.code = code;
    this.detail = detail;
  }
}

const store = new AsyncLocalStorage();

/** Keys whose values are only ever kept as a length. */
const LENGTH_ONLY = new Set(['text', 'password', 'value']);

/** Where finished records go. Set by the app; tests set their own. */
let sink = null;

export function onRecord(fn) {
  sink = fn;
}

/** Note a step in the attempt under way. Does nothing outside one. */
export function note(name, detail) {
  const current = store.getStore();
  if (!current) return;
  const step = { t: Date.now() - current.started, name };
  if (detail !== undefined) step.detail = shorten(detail);
  current.record.steps.push(step);
}

/** A string that must never be written: a password, read from the keychain. */
export function secret(value) {
  const current = store.getStore();
  if (!current || typeof value !== 'string' || !value) return;
  // And the forms it takes on its way through a URL or a script's source.
  for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) {
    current.secrets.add(form);
  }
}

/** How to take a screenshot if this attempt fails. */
export function setCapture(fn) {
  const current = store.getStore();
  if (current) current.capture = fn;
}

/**
 * Tie a callback to the attempt under way, so it records into that attempt
 * whenever it runs. Needed for event listeners: Electron and the protocol fire
 * them from their own loop, outside the attempt that registered them, and a
 * note made there would otherwise go nowhere.
 */
export function bound(fn) {
  return store.getStore() ? AsyncLocalStorage.bind(fn) : fn;
}

/** Whether something is running inside an attempt right now. */
export function inAttempt() {
  return Boolean(store.getStore());
}

/**
 * Run one piece of work as an attempt.
 *
 * @returns {Promise<{ ok: true, value: any, record: object } |
 *   { ok: false, code: string, message: string, record: object }>}
 */
export async function attempt({ kind, requestId = null, portalId = null, target = null }, fn) {
  const started = Date.now();
  const record = {
    id: randomUUID(),
    kind,
    requestId,
    portalId,
    // An agent's URL can be any length; the server keeps the first 2000.
    target: typeof target === 'string' ? target.slice(0, 2000) : target,
    startedAt: new Date(started).toISOString(),
    endedAt: null,
    outcome: null,
    code: null,
    message: null,
    steps: [],
  };
  const current = { record, started, secrets: new Set(), capture: null };
  const outer = store.getStore();

  let value;
  try {
    /*
     * Refused rather than allowed to nest. One attempt's steps belong to one
     * piece of work; a second running inside it would either steal them or
     * hide its own, and both make the trace say something that did not happen.
     */
    if (outer)
      throw new Error(`An attempt (${kind}) was started inside another (${outer.record.kind}).`);
    value = await store.run(current, fn);
    record.outcome = 'ok';
  } catch (error) {
    // expected: this is the recorder -- classify() makes the error the outcome.
    try {
      classify(record, error);
    } catch (unreadable) {
      /*
       * expected: something was thrown that cannot even be read -- its
       * properties throw. The attempt still ends, as internal.no_outcome, and
       * attempt() itself never throws.
       */
      record.error = { name: 'Unreadable', message: safeString(unreadable) };
    }
    if (current.capture) await store.run(current, () => takeScreenshot(current));
  } finally {
    if (!record.outcome) {
      record.outcome = 'failed';
      record.code = 'internal.no_outcome';
      record.message = CODES['internal.no_outcome'];
    }
    record.endedAt = new Date().toISOString();
  }

  const clean = finish(record, current.secrets);
  try {
    sink?.(clean);
  } catch (error) {
    // expected: a sink that cannot keep a record. The outcome stands whatever happens to its record; losing a trace must
    // not turn a page that opened into one that did not.
    console.error('Could not keep a trace record:', error);
  }

  return clean.outcome === 'ok'
    ? { ok: true, value, record: clean }
    : { ok: false, code: clean.code, message: clean.message, record: clean };
}

/** Fill in a failed record from what was thrown. */
function classify(record, error) {
  if (error instanceof Failure) {
    record.code = error.code;
    record.message = error.message;
    if (Object.keys(error.detail).length) record.detail = shorten(error.detail);
  } else {
    // The words of an error we did not write may be the page's, so the
    // agent gets our sentence and the trace gets the rest.
    record.error = {
      name: error?.name ?? typeof error,
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? ''),
    };
    record.code = 'internal.unexpected';
    record.message = CODES['internal.unexpected'];
  }
  record.outcome = 'failed';
}

function safeString(value) {
  try {
    return String(value?.message ?? value);
  } catch {
    // expected: even this cannot be read; say so.
    return '(unreadable)';
  }
}

async function takeScreenshot(current) {
  try {
    const shot = await Promise.race([
      current.capture(),
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (shot) current.record.screenshot = shot;
    else note('capture.empty');
  } catch (error) {
    note('capture.failed', { error: String(error?.message ?? error) });
  }
}

/** Long strings cut, typed values reduced to their length. */
function shorten(detail) {
  if (detail === null || typeof detail !== 'object') return clip(detail);
  if (Array.isArray(detail)) return detail.slice(0, 50).map(shorten);
  const out = {};
  for (const [key, value] of Object.entries(detail)) {
    out[key] =
      LENGTH_ONLY.has(key) && typeof value === 'string'
        ? `[${value.length} chars]`
        : shorten(value);
  }
  return out;
}

function clip(value) {
  return typeof value === 'string' && value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
}

/** A copy of the record with every registered secret blanked. */
/** Most steps one record keeps: the first and last half, and a note of the cut. */
const MAX_STEPS = 1000;

/**
 * The record as it may leave this process: secrets blanked, NUL characters
 * (which Postgres will not store) removed, and a runaway list of steps cut
 * down to what the server accepts -- keeping how it started and how it ended,
 * which is where the explanation is.
 */
function finish(record, secrets) {
  if (record.steps.length > MAX_STEPS) {
    const half = MAX_STEPS / 2 - 1;
    const cut = record.steps.length - 2 * half;
    record.steps = [
      ...record.steps.slice(0, half),
      { t: record.steps[half].t, name: 'trace.steps_cut', detail: { cut } },
      ...record.steps.slice(-half),
    ];
  }
  // Longest secret first, so a password is blanked whole before any shorter
  // form of it that it happens to contain.
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  const blank = (s) => {
    let out = s.replaceAll('\u0000', '');
    for (const secretValue of ordered) out = out.split(secretValue).join('•••');
    return out;
  };
  const walk = (value) => {
    if (typeof value === 'string') return blank(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(record);
}
