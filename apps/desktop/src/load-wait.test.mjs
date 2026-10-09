import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attempt } from './trace.mjs';
import { codeForNetError, waitForLoad } from './load-wait.mjs';

/**
 * A page load has three endings, and they used to be two: a load that failed
 * resolved exactly like one that worked, so "the address does not exist" came
 * back to the agent as an empty page it was told to read.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const contents = (url = 'https://a.test/') =>
  Object.assign(new EventEmitter(), { getURL: () => url });

describe('waitForLoad', () => {
  it('resolves ok with the address and status when the page finishes', async () => {
    const wc = contents('https://a.test/home');
    const done = waitForLoad(wc, { timeoutMs: 30_000 });
    wc.emit('did-navigate', {}, 'https://a.test/home', 200, 'OK');
    wc.emit('did-finish-load');
    await expect(done).resolves.toEqual({ ok: true, url: 'https://a.test/home', status: 200 });
  });

  it('throws the right code when the main frame fails to load', async () => {
    const wc = contents();
    const done = waitForLoad(wc, { timeoutMs: 30_000 });
    wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://nowhere.test/', true);
    await expect(done).rejects.toMatchObject({
      code: 'nav.dns',
      detail: {
        netError: -105,
        description: 'ERR_NAME_NOT_RESOLVED',
        url: 'https://nowhere.test/',
      },
    });
  });

  it('ignores a sub-frame failing, which is an advert and not the page', async () => {
    const wc = contents();
    const done = waitForLoad(wc, { timeoutMs: 30_000 });
    wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.test/', false);
    wc.emit('did-finish-load');
    await expect(done).resolves.toMatchObject({ ok: true });
  });

  it('keeps waiting through an aborted load, which is a redirect replacing it', async () => {
    const wc = contents();
    const { record, value } = await attempt({ kind: 'browse' }, async () => {
      const done = waitForLoad(wc, { timeoutMs: 30_000 });
      wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://a.test/', true);
      wc.emit('did-finish-load');
      return done;
    });
    expect(value).toMatchObject({ ok: true });
    expect(record.steps.map((s) => s.name)).toContain('nav.aborted');
  });

  it('says it timed out, with where it got to, instead of pretending it loaded', async () => {
    const wc = contents('https://slow.test/half');
    const result = await attempt({ kind: 'browse' }, async () => {
      const done = waitForLoad(wc, { timeoutMs: 30_000 });
      await vi.advanceTimersByTimeAsync(30_000);
      return done;
    });
    expect(result.value).toEqual({ ok: false, timedOut: true, url: 'https://slow.test/half' });
    expect(result.record.steps.at(-1)).toMatchObject({
      name: 'nav.timeout',
      detail: { url: 'https://slow.test/half', afterMs: 30_000 },
    });
  });

  it('stops listening once it has an answer', async () => {
    const wc = contents();
    const done = waitForLoad(wc, { timeoutMs: 30_000 });
    wc.emit('did-finish-load');
    await done;
    expect(wc.listenerCount('did-finish-load')).toBe(0);
    expect(wc.listenerCount('did-fail-load')).toBe(0);
    expect(wc.listenerCount('did-navigate')).toBe(0);
  });
});

describe('codeForNetError', () => {
  it.each([
    [-105, 'nav.dns'],
    [-137, 'nav.dns'],
    [-106, 'nav.offline'],
    [-102, 'nav.connection'],
    [-118, 'nav.connection'],
    [-200, 'nav.cert'],
    [-202, 'nav.cert'],
    [-20, 'nav.blocked'],
    [-21, 'nav.blocked'],
    [-301, 'nav.blocked'],
    [-7, 'nav.timeout'],
    [-2, 'nav.failed'],
  ])('maps %i to %s', (error, code) => {
    expect(codeForNetError(error)).toBe(code);
  });
});

describe('events Electron fires from outside the attempt', () => {
  it('still land in the attempt that was listening', async () => {
    vi.useRealTimers();
    const wc = contents('https://a.test/');
    // Fired from a timer made before the attempt began -- the way Electron's
    // own event loop delivers did-navigate, with no attempt in its context.
    const fire = (cb) => setTimeout(cb, 5);
    let later;
    fire(() => later?.());
    const { record } = await attempt({ kind: 'browse' }, async () => {
      const done = waitForLoad(wc, { timeoutMs: 1000 });
      later = () => {
        wc.emit('did-navigate', {}, 'https://a.test/', 200, 'OK');
        wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://a.test/', true);
        wc.emit('did-finish-load');
      };
      return done;
    });
    expect(record.steps.map((s) => s.name)).toEqual(['nav.response', 'nav.aborted']);
  });
});

describe('codeForNetErrorName', () => {
  it.each([
    ['net::ERR_NAME_NOT_RESOLVED', 'nav.dns'],
    ['net::ERR_INTERNET_DISCONNECTED', 'nav.offline'],
    ['net::ERR_CONNECTION_REFUSED', 'nav.connection'],
    ['net::ERR_ADDRESS_UNREACHABLE', 'nav.connection'],
    ['net::ERR_CERT_DATE_INVALID', 'nav.cert'],
    ['net::ERR_BLOCKED_BY_ADMINISTRATOR', 'nav.blocked'],
    ['net::ERR_TIMED_OUT', 'nav.timeout'],
    ['net::ERR_ABORTED', null],
    ['net::ERR_SOMETHING_NEW', 'nav.failed'],
  ])('maps %s to %s', async (name, code) => {
    const { codeForNetErrorName } = await import('./load-wait.mjs');
    expect(codeForNetErrorName(name)).toBe(code);
  });
});
