import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODES } from './failure-codes.mjs';
import { Failure, attempt, note, onRecord, secret, setCapture } from './trace.mjs';

/**
 * The recorder is the floor everything else stands on: if an attempt can end
 * without an outcome, or a password can reach a trace, every diagnosis built on
 * top of it is wrong in a way nobody would notice.
 */

afterEach(() => onRecord(null));

describe('attempt', () => {
  it('records a success with its steps in order', async () => {
    const result = await attempt({ kind: 'browse', target: 'https://a.test/' }, async () => {
      note('first');
      note('second', { n: 2 });
      return 'value';
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe('value');
    expect(result.record.outcome).toBe('ok');
    expect(result.record.code).toBeNull();
    expect(result.record.steps.map((s) => s.name)).toEqual(['first', 'second']);
    expect(result.record.steps[1].detail).toEqual({ n: 2 });
    for (const step of result.record.steps) expect(step.t).toBeGreaterThanOrEqual(0);
    expect(result.record.endedAt >= result.record.startedAt).toBe(true);
  });

  it('records a coded failure with the message it was given', async () => {
    const result = await attempt({ kind: 'browse' }, async () => {
      throw new Failure('nav.dns', 'a.test does not exist');
    });
    expect(result).toMatchObject({ ok: false, code: 'nav.dns', message: 'a.test does not exist' });
    expect(result.record).toMatchObject({ outcome: 'failed', code: 'nav.dns' });
  });

  it('falls back to the code’s own sentence when a failure has no message', async () => {
    const result = await attempt({ kind: 'browse' }, async () => {
      throw new Failure('nav.dns');
    });
    expect(result.message).toBe(CODES['nav.dns']);
  });

  it('turns an unexpected error into internal.unexpected without passing its words on', async () => {
    const result = await attempt({ kind: 'act' }, async () => {
      throw new TypeError('boom from the page');
    });
    expect(result.code).toBe('internal.unexpected');
    expect(result.message).toBe(CODES['internal.unexpected']);
    expect(result.message).not.toContain('boom');
    expect(result.record.error).toMatchObject({ name: 'TypeError', message: 'boom from the page' });
    expect(result.record.error.stack).toContain('TypeError');
  });

  it('refuses a code that is not on the list', () => {
    expect(() => new Failure('made.up')).toThrow(/made\.up/);
  });

  it('never writes a registered secret, wherever it turns up', async () => {
    const result = await attempt({ kind: 'sign_in' }, async () => {
      secret('hunter2');
      note('page said', { msg: 'wrong password hunter2 here' });
      throw new Error('script failed near "hunter2"');
    });
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(result.record.steps[0].detail.msg).toContain('•••');
  });

  it('keeps only the length of typed text, passwords and values', async () => {
    const { record } = await attempt({ kind: 'act' }, async () => {
      note('typed', { text: 'abc', password: 'secret!', value: '', ref: 4 });
    });
    expect(record.steps[0].detail).toEqual({
      text: '[3 chars]',
      password: '[7 chars]',
      value: '[0 chars]',
      ref: 4,
    });
  });

  it('ignores a note made outside any attempt', () => {
    expect(() => note('nowhere', { a: 1 })).not.toThrow();
  });

  it('refuses an attempt started inside another, rather than mixing their steps', async () => {
    const outer = await attempt({ kind: 'act' }, async () => {
      const inner = await attempt({ kind: 'browse' }, async () => 'x');
      expect(inner.ok).toBe(false);
      expect(inner.code).toBe('internal.unexpected');
      expect(inner.record.error.message).toMatch(/inside another/);
      return 'outer';
    });
    expect(outer.ok).toBe(true);
  });

  it('takes a screenshot only when the attempt fails', async () => {
    const capture = vi.fn(async () => 'data:image/jpeg;base64,AAA');
    const ok = await attempt({ kind: 'browse' }, async () => {
      setCapture(capture);
    });
    expect(capture).not.toHaveBeenCalled();
    expect(ok.record.screenshot).toBeUndefined();

    const failed = await attempt({ kind: 'browse' }, async () => {
      setCapture(capture);
      throw new Failure('nav.timeout');
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(failed.record.screenshot).toBe('data:image/jpeg;base64,AAA');
  });

  it('records a screenshot that could not be taken, and keeps the outcome', async () => {
    const result = await attempt({ kind: 'browse' }, async () => {
      setCapture(async () => {
        throw new Error('view gone');
      });
      throw new Failure('nav.timeout');
    });
    expect(result.code).toBe('nav.timeout');
    expect(result.record.steps.at(-1)).toMatchObject({
      name: 'capture.failed',
      detail: { error: 'view gone' },
    });
  });

  it('hands every finished record to the sink, and survives a sink that throws', async () => {
    const seen = [];
    onRecord((record) => seen.push(record.id));
    await attempt({ kind: 'browse' }, async () => 'a');
    expect(seen).toHaveLength(1);

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onRecord(() => {
      throw new Error('disk full');
    });
    const result = await attempt({ kind: 'browse' }, async () => 'b');
    expect(result.ok).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('gives each record an id and carries what it was for', async () => {
    const { record } = await attempt(
      { kind: 'sync', requestId: 'r1', portalId: 'kognity', target: 'https://k.test' },
      async () => {},
    );
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record).toMatchObject({
      kind: 'sync',
      requestId: 'r1',
      portalId: 'kognity',
      target: 'https://k.test',
    });
  });
});

describe('CODES', () => {
  it('gives every code a sentence', () => {
    for (const [code, sentence] of Object.entries(CODES)) {
      expect(code).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(sentence.length).toBeGreaterThan(10);
    }
  });
});

describe('something thrown that cannot be read', () => {
  it('still ends the attempt, as internal.no_outcome, without throwing', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('do not touch');
        },
        getPrototypeOf() {
          return Object.prototype;
        },
      },
    );
    const result = await attempt({ kind: 'act' }, async () => {
      throw hostile;
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('internal.no_outcome');
    expect(result.message).toBe(CODES['internal.no_outcome']);
    expect(result.record.error).toMatchObject({ name: 'Unreadable' });
  });
});
