import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Talking to the server.
 *
 * The droplet cannot dial in -- a student's laptop is behind NAT with no
 * public address -- so every exchange starts here and goes outward. The app
 * links once, keeps a token, and pushes portal maps up. The agent then answers
 * from what has already arrived, which is why it can still say what is due at
 * midnight with the laptop shut.
 */

const CONFIG_DIR =
  {
    darwin: () => join(homedir(), 'Library', 'Application Support', 'ContextoAgent'),
    win32: () => join(process.env['APPDATA'] ?? homedir(), 'ContextoAgent'),
  }[platform()] ?? (() => join(homedir(), '.config', 'contexto-agent'));

export function configPath() {
  /*
   * Overridable so tests never touch a real install.
   *
   * They did, twice, and both times it destroyed a working device token --
   * the credential is not recoverable from the server, which stores only its
   * hash, so the only repair is linking again. A test that can reach the
   * student's own config is a test that will eventually break it.
   */
  const override = process.env['CONTEXTO_CONFIG_DIR'];
  return join(override || CONFIG_DIR(), 'config.json');
}

/** Where portal browser profiles live, alongside the config. */
export function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(config) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
  // The device token is a standing credential for this student's account.
  // Owner-only, so another account on a shared family machine cannot read it.
  chmodSync(path, 0o600);
}

/**
 * Open a page in whatever browser the student uses.
 *
 * Inert under test, and that is not belt-and-braces -- it is a bug fix. The
 * linking test drives this function with the made-up host the suite uses, so
 * every run spawned a real tab and left a blank x.test page sitting on the
 * developer's desktop. A test must never reach out of the process it runs in.
 *
 * Returns whether it actually opened anything, so that is testable rather
 * than something you find out by watching your own screen.
 */
export function openInBrowser(url) {
  if (process.env['NODE_ENV'] === 'test') return false;
  const [command, args] =
    platform() === 'darwin'
      ? ['open', [url]]
      : platform() === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  return true;
}

/**
 * The server no longer recognises this machine.
 *
 * Distinct from a network failure, because the responses are opposite: a
 * flaky connection should be retried, an unlinked device must stop and ask
 * the student to link again. Retrying that one forever would mean an app
 * quietly failing every six hours with no way to notice.
 */
export class DeviceUnlinked extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeviceUnlinked';
  }
}

async function api(baseUrl, path, { method = 'POST', token, body } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();

  /*
   * Not everything that answers is our API.
   *
   * A proxy error page, a 404 from a server that has never heard of these
   * routes, a captive portal on school wifi -- all reply with HTML or plain
   * text. Parsing that without a guard threw a raw
   * "Unexpected non-whitespace character after JSON" at the student, which
   * says nothing about what actually went wrong.
   */
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = null;
  }

  if (response.status === 401 && token) {
    throw new DeviceUnlinked(parsed?.message ?? 'This computer is no longer linked.');
  }

  if (parsed === null) {
    // Naming the address matters: the usual cause is pointing at a server
    // that does not have these routes yet, and the address is the clue.
    throw new Error(
      response.status === 404
        ? `${new URL(path, baseUrl).origin} has no device-linking API. ` +
            'Is CONTEXTO_API pointing at the right server, and is it up to date?'
        : `${new URL(path, baseUrl).origin} answered ${response.status} with something that ` +
            'was not JSON. It may be a proxy or sign-in page rather than the API.',
    );
  }

  if (!response.ok) {
    throw new Error(parsed.message ?? `${method} ${path} failed with ${response.status}`);
  }
  return parsed;
}

/**
 * Link this machine to a student's account.
 *
 * The token is never shown to the student and never typed by them. They only
 * ever click Approve inside a session they already had.
 */
export async function link({
  apiBase,
  webBase,
  deviceName = hostname(),
  pollMs = 2000,
  timeoutMs = 600_000,
  // Injectable so a test can watch where linking would send the student
  // instead of sending them there.
  open = openInBrowser,
}) {
  const { requestId } = await api(apiBase, '/api/devices/link/start', { body: { deviceName } });
  const approvalUrl = new URL(`/link/${requestId}`, webBase).toString();

  console.log(`\n  Approve this computer at:\n    ${approvalUrl}\n`);
  open(approvalUrl);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await api(apiBase, `/api/devices/link/${requestId}/claim`);
    if (result.status === 'linked') {
      writeConfig({
        ...readConfig(),
        apiBase,
        token: result.token,
        deviceId: result.deviceId,
        deviceName,
        /*
         * The web session that came back with the approval.
         *
         * Kept so the app stays signed in across restarts. The student already
         * answered "who are you" in the browser to approve this; asking again
         * inside the app would be asking the same question twice.
         */
        sessionToken: result.sessionToken ?? null,
      });
      return { deviceId: result.deviceId, deviceName, sessionToken: result.sessionToken ?? null };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error('Timed out waiting for approval.');
}

/**
 * Is the session we are holding still good?
 *
 * Sessions expire. Asking is cheap and the alternative is an app that is
 * silently signed out for good, because a stored-but-dead token looks exactly
 * like a working one from here.
 */
export async function sessionValid({ apiBase, sessionToken }) {
  if (!sessionToken) return false;
  try {
    const response = await fetch(new URL('/api/devices', apiBase), {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    return response.ok;
  } catch {
    // Offline. Treat the session as good rather than throwing it away over a
    // dropped connection -- it may well still work once there is a network.
    return true;
  }
}

/**
 * Get a web session using the device link we already have.
 *
 * Called when the app is linked but holds no usable session -- after the
 * session expired, or after an older build linked without asking for one.
 * Better than sending the student back through linking to answer a question
 * they already answered.
 */
export async function refreshSession({ apiBase, token }) {
  const { sessionToken } = await api(apiBase, '/api/devices/session', { token });
  writeConfig({ ...readConfig(), sessionToken });
  return sessionToken;
}

/** Work the agent has asked this machine to do. */
export async function pendingWork({ apiBase, token }) {
  return api(apiBase, '/api/devices/pending', { method: 'GET', token });
}

export async function reportWork({ apiBase, token }, requestId, outcome, result) {
  return api(apiBase, `/api/devices/pending/${requestId}/complete`, {
    token,
    body: { outcome, ...(result === undefined ? {} : { result }) },
  });
}

/** Push a portal map to the server. */
export async function pushSnapshot({ apiBase, token }, { portalId, origin, map, redacted }) {
  return api(apiBase, '/api/devices/portal-snapshot', {
    token,
    body: { portalId, origin, redacted, capturedAt: map.exploredAt, map },
  });
}

/** Send one trace of browser work. Re-sending the same one is harmless. */
export async function uploadAttempt({ apiBase, token }, record) {
  return api(apiBase, '/api/devices/attempts', { token, body: record });
}

/**
 * Say what this machine is doing right now: null when idle, or the work that
 * holds the browser. Lets the agent's wait end with "busy" rather than "asleep".
 */
export async function heartbeat({ apiBase, token }, busy) {
  return api(apiBase, '/api/devices/heartbeat', {
    token,
    body: { busy: busy ?? null, version: process.env['npm_package_version'] },
  });
}
