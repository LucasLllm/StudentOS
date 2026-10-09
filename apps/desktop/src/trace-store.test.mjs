import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushOutbox, logDir, logEvent, queueUpload, writeLocal } from './trace-store.mjs';

/** The suite's own log folder (vitest.config.ts), restored after each override. */
const TEST_LOG_DIR = process.env['CONTEXTO_LOG_DIR'];

/**
 * A trace is only worth anything if it survives the failure it describes --
 * which is often "the network was gone". So it is written on the Mac first,
 * and an upload that fails leaves it waiting rather than losing it.
 */

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cx-traces-'));
  process.env['CONTEXTO_LOG_DIR'] = dir;
});
afterEach(() => {
  process.env['CONTEXTO_LOG_DIR'] = TEST_LOG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const record = (id, extra = {}) => ({
  id,
  kind: 'browse',
  startedAt: '2026-10-09T12:00:00.000Z',
  outcome: 'failed',
  code: 'nav.dns',
  steps: [],
  ...extra,
});

const today = () =>
  readFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');

describe('writeLocal', () => {
  it('appends one line per record to the day’s file', () => {
    writeLocal(record('a'));
    writeLocal(record('b'));
    const lines = today().trim().split('\n').map(JSON.parse);
    expect(lines.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('keeps screenshots out of the local file', () => {
    writeLocal(record('a', { screenshot: 'data:image/jpeg;base64,' + 'A'.repeat(5000) }));
    const [line] = today().trim().split('\n').map(JSON.parse);
    expect(line.screenshot).toBeUndefined();
    expect(line.hadScreenshot).toBe(true);
  });

  it('uses the override directory', () => {
    expect(logDir()).toBe(dir);
  });
});

describe('logEvent', () => {
  it('writes an app-level event line', () => {
    logEvent('transport.offline', 'no network', { since: 'x' });
    const [line] = today().trim().split('\n').map(JSON.parse);
    expect(line).toMatchObject({
      kind: 'event',
      code: 'transport.offline',
      message: 'no network',
      detail: { since: 'x' },
    });
    expect(line.at).toBeTruthy();
  });
});

describe('outbox', () => {
  it('keeps a record whose upload failed, and sends it on the next flush', async () => {
    queueUpload(record('a', { screenshot: 'data:x' }));
    const failing = async () => {
      throw new Error('offline');
    };
    expect(await flushOutbox(failing)).toEqual({ sent: 0, kept: 1 });
    expect(readdirSync(join(dir, 'outbox'))).toEqual(['a.json']);
    expect(today()).toContain('"code":"transport.report_failed"');

    const sent = [];
    expect(await flushOutbox(async (r) => sent.push(r))).toEqual({ sent: 1, kept: 0 });
    expect(sent[0]).toMatchObject({ id: 'a', screenshot: 'data:x' });
    expect(readdirSync(join(dir, 'outbox'))).toEqual([]);
  });

  it('sends oldest first and stops at the first failure, so order is kept', async () => {
    queueUpload(record('a', { startedAt: '2026-10-09T12:00:00.000Z' }));
    queueUpload(record('b', { startedAt: '2026-10-09T12:00:01.000Z' }));
    const sent = [];
    const result = await flushOutbox(async (r) => {
      if (r.id === 'b') throw new Error('offline');
      sent.push(r.id);
    });
    expect(sent).toEqual(['a']);
    expect(result).toEqual({ sent: 1, kept: 1 });
  });

  it('drops a file that is not a record instead of retrying it forever', async () => {
    queueUpload(record('a'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'outbox', 'broken.json'), '{not json');
    const result = await flushOutbox(async () => {});
    expect(result.sent).toBe(1);
    expect(readdirSync(join(dir, 'outbox'))).toEqual([]);
  });
});

describe('outbox, when the server refuses a trace', () => {
  const refused = (status) => {
    const error = new Error(`refused ${status}`);
    error.status = status;
    return error;
  };

  it('sets aside a trace the server will never take, and sends the rest', async () => {
    queueUpload(record('a', { startedAt: '2026-10-09T12:00:00.000Z' }));
    queueUpload(record('b', { startedAt: '2026-10-09T12:00:01.000Z' }));
    const sent = [];
    const result = await flushOutbox(async (r) => {
      if (r.id === 'a') throw refused(400);
      sent.push(r.id);
    });
    expect(sent).toEqual(['b']);
    expect(result).toEqual({ sent: 1, kept: 0, setAside: 1 });
    expect(readdirSync(join(dir, 'outbox', 'rejected'))).toEqual(['a.json']);
  });

  it('keeps trying after a sign-in problem or a server error', async () => {
    queueUpload(record('a'));
    for (const status of [401, 429, 500]) {
      const result = await flushOutbox(async () => {
        throw refused(status);
      });
      expect(result.kept).toBe(1);
    }
  });

  it('sets aside a trace that has failed too many times, so it cannot block forever', async () => {
    queueUpload(record('a'));
    let result;
    for (let i = 0; i < 50; i += 1) {
      result = await flushOutbox(async () => {
        throw refused(500);
      });
    }
    expect(result.setAside).toBe(1);
    expect(readdirSync(join(dir, 'outbox', 'rejected'))).toEqual(['a.json']);
  });

  it('never sends its own bookkeeping', async () => {
    queueUpload(record('a'));
    await flushOutbox(async () => {
      throw refused(500);
    });
    const sent = [];
    await flushOutbox(async (r) => sent.push(r));
    expect(sent[0]._uploadTries).toBeUndefined();
  });
});
