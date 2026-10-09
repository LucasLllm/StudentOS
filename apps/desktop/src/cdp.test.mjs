import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CdpConnection } from './cdp.mjs';

/**
 * The last time this codebase shipped a transport, every unit test passed and
 * the feature was broken in production, because the tests never exercised the
 * real wire format. So these drive the actual framing: NUL delimiters, replies
 * split across chunks, error responses, and session routing.
 */
function harness() {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const cdp = new CdpConnection(toBrowser, fromBrowser);
  const sent = [];
  toBrowser.on('data', (chunk) => {
    for (const part of chunk.toString().split('\0')) if (part) sent.push(JSON.parse(part));
  });
  const reply = (message) => fromBrowser.write(JSON.stringify(message) + '\0');
  return { cdp, sent, reply, fromBrowser };
}

describe('CdpConnection', () => {
  it('frames commands as NUL-terminated JSON', async () => {
    const { cdp, sent, reply } = harness();
    const pending = cdp.send('Browser.getVersion');
    await new Promise((r) => setImmediate(r));
    expect(sent[0]).toEqual({ id: 1, method: 'Browser.getVersion', params: {} });
    reply({ id: 1, result: { product: 'Chrome/151' } });
    await expect(pending).resolves.toEqual({ product: 'Chrome/151' });
  });

  it('reassembles a reply split across chunks', async () => {
    const { cdp, reply: _r, fromBrowser } = harness();
    const pending = cdp.send('Page.navigate');
    await new Promise((r) => setImmediate(r));
    const payload = JSON.stringify({ id: 1, result: { frameId: 'F1' } }) + '\0';
    fromBrowser.write(payload.slice(0, 9));
    fromBrowser.write(payload.slice(9));
    await expect(pending).resolves.toEqual({ frameId: 'F1' });
  });

  it('handles two replies arriving in one chunk', async () => {
    const { cdp, fromBrowser } = harness();
    const a = cdp.send('A');
    const b = cdp.send('B');
    await new Promise((r) => setImmediate(r));
    fromBrowser.write(
      JSON.stringify({ id: 1, result: { v: 'a' } }) +
        '\0' +
        JSON.stringify({ id: 2, result: { v: 'b' } }) +
        '\0',
    );
    expect(await a).toEqual({ v: 'a' });
    expect(await b).toEqual({ v: 'b' });
  });

  it('rejects when the browser returns a protocol error', async () => {
    const { cdp, reply } = harness();
    const pending = cdp.send('Network.getResponseBody');
    await new Promise((r) => setImmediate(r));
    reply({ id: 1, error: { code: -32000, message: 'No resource with given identifier' } });
    await expect(pending).rejects.toThrow('No resource with given identifier');
  });

  it('attaches sessionId to commands and routes events by session', async () => {
    const { cdp, sent, reply } = harness();
    const mine = [];
    const theirs = [];
    cdp.on('Network.responseReceived', (p) => mine.push(p), 'SESSION-A');
    cdp.on('Network.responseReceived', (p) => theirs.push(p), 'SESSION-B');

    cdp.send('Network.enable', {}, 'SESSION-A');
    await new Promise((r) => setImmediate(r));
    expect(sent[0].sessionId).toBe('SESSION-A');

    reply({
      method: 'Network.responseReceived',
      sessionId: 'SESSION-A',
      params: { requestId: '1' },
    });
    await new Promise((r) => setImmediate(r));
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it('fails pending commands when the pipe closes', async () => {
    const { cdp, fromBrowser } = harness();
    const pending = cdp.send('Browser.getVersion');
    await new Promise((r) => setImmediate(r));
    fromBrowser.destroy();
    await expect(pending).rejects.toThrow(/pipe/i);
  });
});

describe('CdpConnection, when Chrome stops answering', () => {
  it('gives up on a command with no reply, instead of hanging the CLI', async () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const cdp = new CdpConnection(toBrowser, fromBrowser, { timeoutMs: 20 });
    await expect(cdp.send('Page.navigate')).rejects.toMatchObject({ code: 'nav.timeout' });
  });

  it('survives a frame that is not JSON and still answers the next one', async () => {
    const { cdp, reply, fromBrowser } = harness();
    const pending = cdp.send('Browser.getVersion');
    await new Promise((r) => setImmediate(r));
    fromBrowser.write('{not json\0');
    reply({ id: 1, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });
});
