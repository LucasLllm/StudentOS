/**
 * Where traces are kept: on this Mac first, then on the server.
 *
 * Written locally before anything else, because the failure a trace describes
 * is often the reason it cannot be sent -- no network, a server that is down.
 * A trace that only existed in an upload would vanish exactly when it mattered.
 *
 * The local log is one JSON line per record, a file per day, in the place macOS
 * keeps app logs. Screenshots stay out of it; they are large and only useful on
 * the debug page, so they travel with the upload alone.
 *
 * The outbox is a folder of records still to send. A send that fails leaves the
 * file where it is, and the next flush tries again, oldest first.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function logDir() {
  return (
    process.env['CONTEXTO_LOG_DIR'] || join(homedir(), 'Library', 'Logs', 'ContextoAgent', 'traces')
  );
}

function ensure(dir) {
  // Owner-only: a trace names the sites a student uses and what was on them.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function todaysFile() {
  return join(ensure(logDir()), `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

/** Keep a finished record on this Mac. */
export function writeLocal(record) {
  const { screenshot, ...rest } = record;
  const line = screenshot ? { ...rest, hadScreenshot: true } : rest;
  appendFileSync(todaysFile(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/**
 * Something the app noticed outside any one piece of work: the network went,
 * the device was unlinked, a report could not be sent. Local only.
 */
export function logEvent(code, message, detail) {
  const line = { kind: 'event', at: new Date().toISOString(), code, message };
  if (detail !== undefined) line.detail = detail;
  try {
    appendFileSync(todaysFile(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (error) {
    // expected: the log itself is unwritable (disk full, permissions). There
    // is nowhere left to record that except the console.
    console.error('Could not write to the trace log:', error);
  }
}

const outboxDir = () => ensure(join(logDir(), 'outbox'));

/** Hold a record until it has been sent. */
export function queueUpload(record) {
  writeFileSync(join(outboxDir(), `${record.id}.json`), JSON.stringify(record), { mode: 0o600 });
}

/**
 * Send what is waiting, oldest first, stopping at the first failure.
 *
 * Stopping rather than skipping: a failure is nearly always the network, and
 * the next record would fail the same way. The order also stays the order
 * things happened in.
 *
 * @param {(record: object) => Promise<unknown>} send
 * @returns {Promise<{ sent: number, kept: number }>}
 */
export async function flushOutbox(send) {
  const dir = outboxDir();
  const waiting = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const path = join(dir, name);
    try {
      waiting.push({ path, record: JSON.parse(readFileSync(path, 'utf8')) });
    } catch (error) {
      // A half-written file from a crash. It can never be sent, so keeping it
      // would block every flush after it.
      logEvent('internal.unexpected', 'Dropped an unreadable trace from the outbox.', {
        file: name,
        error: String(error?.message ?? error),
      });
      rmSync(path, { force: true });
    }
  }
  waiting.sort((a, b) => String(a.record.startedAt).localeCompare(String(b.record.startedAt)));

  let sent = 0;
  for (const { path, record } of waiting) {
    try {
      await send(record);
    } catch (error) {
      logEvent('transport.report_failed', 'A trace could not be sent; it will be tried again.', {
        id: record.id,
        error: String(error?.message ?? error),
      });
      return { sent, kept: waiting.length - sent };
    }
    rmSync(path, { force: true });
    sent += 1;
  }
  return { sent, kept: 0 };
}
