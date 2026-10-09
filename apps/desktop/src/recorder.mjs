/**
 * Watching a portal fetch its own data.
 *
 * Veracross and Mozaik are single-page apps: the page you see is assembled in
 * the browser from JSON their own front-end requests. Scraping the rendered
 * DOM -- or worse, screenshotting it and asking a model to read it -- throws
 * that structure away and then pays to reconstruct it badly. Recording the
 * JSON instead gives us exactly the data the portal's own UI is built from.
 *
 * The output of a recording session is not student data we intend to keep. It
 * is a specification: the endpoints a portal exposes and the shape of what
 * they return, which is what someone needs in order to write an adapter.
 * Because of that, values are redacted by default and only the shape survives.
 */

const INTERESTING = new Set(['XHR', 'Fetch']);

/** Recursive type skeleton. Keeps structure, drops content. */
export function summarizeShape(value, { raw = false, depth = 0 } = {}) {
  if (depth > 6) return '…';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [summarizeShape(value[0], { raw, depth: depth + 1 }), `…${value.length} items`];
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 60)
        .map(([k, v]) => [k, summarizeShape(v, { raw, depth: depth + 1 })]),
    );
  }
  if (raw) return value;
  // A redacted scalar still tells an adapter author what they need: the type,
  // and for strings a length band that distinguishes an id from an essay.
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'string<date>';
    return `string<${value.length <= 24 ? 'short' : value.length <= 200 ? 'medium' : 'long'}>`;
  }
  return typeof value;
}

/**
 * Record JSON traffic while the student browses.
 *
 * @param {import('./browser.mjs').PortalBrowser} browser
 * @param {string} sessionId
 * @param {{ raw?: boolean }} options
 */
export function startRecording(browser, sessionId, { raw = false } = {}) {
  const cdp = browser.cdp;
  const requests = new Map(); // requestId -> metadata
  const methods = new Map(); // requestId -> HTTP verb
  const endpoints = new Map(); // grouping key -> record

  // responseReceived does not reliably carry the verb, and GET vs POST is the
  // difference between an adapter that works and one that 405s. Record it at
  // request time instead.
  const offRequest = cdp.on(
    'Network.requestWillBeSent',
    (params) => methods.set(params.requestId, params.request.method),
    sessionId,
  );

  const offResponse = cdp.on(
    'Network.responseReceived',
    (params) => {
      if (!INTERESTING.has(params.type)) return;
      if (!/json/i.test(params.response.mimeType)) return;
      requests.set(params.requestId, {
        url: params.response.url,
        status: params.response.status,
        mimeType: params.response.mimeType,
        method: methods.get(params.requestId) ?? 'GET',
      });
    },
    sessionId,
  );

  const offFinished = cdp.on(
    'Network.loadingFinished',
    async (params) => {
      const meta = requests.get(params.requestId);
      if (!meta) return;
      requests.delete(params.requestId);
      methods.delete(params.requestId);
      let shape = null;
      try {
        const { body, base64Encoded } = await cdp.send(
          'Network.getResponseBody',
          { requestId: params.requestId },
          sessionId,
        );
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        shape = summarizeShape(JSON.parse(text), { raw });
      } catch {
        // expected: body already evicted from Chrome's buffer, or not valid
        // JSON after all. The endpoint is still worth reporting without its shape.
      }
      const parsed = new URL(meta.url);
      const key = `${meta.method} ${parsed.origin}${parsed.pathname}`;
      const existing = endpoints.get(key);
      if (existing) {
        existing.hits += 1;
        existing.shape ??= shape;
        for (const p of parsed.searchParams.keys()) existing.queryParams.add(p);
        return;
      }
      endpoints.set(key, {
        method: meta.method,
        url: `${parsed.origin}${parsed.pathname}`,
        status: meta.status,
        mimeType: meta.mimeType,
        queryParams: new Set(parsed.searchParams.keys()),
        hits: 1,
        shape,
      });
    },
    sessionId,
  );

  return {
    async enable() {
      await cdp.send('Network.enable', {}, sessionId);
    },
    stop() {
      offRequest();
      offResponse();
      offFinished();
      return {
        recordedAt: new Date().toISOString(),
        redacted: !raw,
        endpoints: [...endpoints.values()]
          .sort((a, b) => b.hits - a.hits)
          .map((e) => ({ ...e, queryParams: [...e.queryParams] })),
      };
    },
  };
}
