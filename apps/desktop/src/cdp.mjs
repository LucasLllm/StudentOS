/**
 * A Chrome DevTools Protocol client, spoken over a pipe rather than a port.
 *
 * The obvious way to do this is `--remote-debugging-port=9222`, which opens a
 * TCP listener on localhost. Don't. That listener is unauthenticated: ANY
 * process on the machine can connect to it and drive the browser -- read the
 * page, execute JavaScript, steal cookies. That is not hypothetical. It is
 * exactly how researchers took over Claude's own Chrome extension in March
 * 2026, via an unauthenticated local IPC endpoint.
 *
 * `--remote-debugging-pipe` hands the protocol to us over inherited file
 * descriptors instead. There is no socket to connect to, so the browser
 * driving a student's logged-in school portal is reachable only by this
 * process and its children.
 *
 * Framing is NUL-delimited JSON: Chrome reads commands from fd 3 and writes
 * replies and events to fd 4.
 */

import { Failure, note } from './trace.mjs';
export class CdpConnection {
  #write;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();
  #buffer = Buffer.alloc(0);
  #closed = null;
  #timeoutMs;

  /**
   * @param {import('node:stream').Writable} toBrowser   child fd 3
   * @param {import('node:stream').Readable} fromBrowser child fd 4
   */
  /**
   * @param {{ timeoutMs?: number }} [options] how long a command may go
   *   unanswered. A Chrome that is alive but stuck used to hang the CLI forever.
   */
  constructor(toBrowser, fromBrowser, { timeoutMs = 30_000 } = {}) {
    this.#timeoutMs = timeoutMs;
    this.#write = toBrowser;
    fromBrowser.on('data', (chunk) => this.#consume(chunk));
    fromBrowser.on('close', () => this.#fail(new Error('Browser closed the DevTools pipe.')));
    toBrowser.on('error', (error) => this.#fail(error));
  }

  #consume(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let index;
    while ((index = this.#buffer.indexOf(0)) !== -1) {
      const raw = this.#buffer.subarray(0, index).toString('utf8');
      this.#buffer = this.#buffer.subarray(index + 1);
      if (raw.length === 0) continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        // One garbled frame is dropped, not allowed to take the pipe down.
        note('cdp.bad_frame', { error: error.message, length: raw.length });
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const { resolve, reject } = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) reject(new Error(`${message.method ?? 'CDP'}: ${message.error.message}`));
      else resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    // Events are keyed by method and session so a listener on one page does
    // not receive another page's traffic.
    for (const key of [`${message.sessionId ?? ''}:${message.method}`, `*:${message.method}`]) {
      for (const handler of this.#listeners.get(key) ?? [])
        handler(message.params ?? {}, message.sessionId);
    }
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = error;
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }

  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Failure('nav.timeout', `Chrome did not answer ${method} in time.`, { method }));
      }, this.#timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#write.write(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
      );
    });
  }

  /** Subscribe to a CDP event. Omit sessionId to hear it from every session. */
  on(method, handler, sessionId) {
    const key = `${sessionId ?? '*'}:${method}`;
    if (!this.#listeners.has(key)) this.#listeners.set(key, new Set());
    this.#listeners.get(key).add(handler);
    return () => this.#listeners.get(key)?.delete(handler);
  }

  /**
   * Attach to a page and get a session id for it.
   *
   * `flatten: true` multiplexes the page's messages onto this same pipe,
   * tagged with the session id, instead of the deprecated nested-message
   * protocol. Everything downstream assumes flattened sessions.
   */
  async attachToTarget(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }
}
