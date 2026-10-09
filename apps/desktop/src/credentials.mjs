import { execFileSync } from 'node:child_process';
import { Failure, note, secret } from './trace.mjs';

/**
 * Site sign-ins, kept in the login keychain.
 *
 * Deliberately NOT on the server and NOT in config.json. This is a student's
 * actual school password, often a minor's, and often the same password they
 * use elsewhere. Holding it centrally would mean one breach of our database
 * exposed school accounts belonging to people who never chose that risk. The
 * keychain is encrypted at rest, unlocked by their own login, and is where
 * macOS expects a credential to live -- so the blast radius of losing this
 * laptop is the same with us as without us.
 *
 * The server never sees these. It receives pages, never the means to fetch
 * them.
 */

const SERVICE = (portalId) => `ContextoAgent: ${portalId}`;

/** macOS only. Elsewhere the app simply does not offer to remember a sign-in. */
export function keychainAvailable() {
  return process.platform === 'darwin';
}

export function saveCredentials(portalId, { username, password }) {
  if (!keychainAvailable()) throw new Error('Saved sign-ins need the macOS keychain.');
  if (!username || !password) throw new Error('Both a username and a password are needed.');
  /*
   * The password goes through argv. On macOS a process's arguments are
   * readable only by its own user, so this is the same audience that can
   * already read the keychain once it is unlocked -- but it is worth knowing
   * that it is momentarily there rather than assuming otherwise.
   */
  execFileSync(
    'security',
    ['add-generic-password', '-a', username, '-s', SERVICE(portalId), '-w', password, '-U'],
    { stdio: 'ignore' },
  );
  return { username };
}

/** What `security` exits with when there is no such item (errSecItemNotFound). */
const NOT_FOUND = 44;

/**
 * The saved sign-in for a site, or null when there is none.
 *
 * Throws when there is one but the keychain would not hand it over -- the
 * student declined the prompt, or the keychain is locked. That used to read as
 * "no saved sign-in", which sent everyone looking for a sign-in that was there
 * all along.
 *
 * The password is registered as a secret with the trace under way, so it is
 * blanked wherever it might turn up in one.
 *
 * @returns {{ username: string, password: string } | null}
 */
export function readCredentials(portalId, { exec = execFileSync } = {}) {
  if (!keychainAvailable()) return null;
  try {
    const password = exec(
      'security',
      ['find-generic-password', '-s', SERVICE(portalId), '-w'],
      // stderr silenced: "item could not be found" is the normal answer for a
      // site with no saved sign-in, and printing it makes a routine state look
      // like a fault.
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).replace(/\n$/, '');
    const dump = exec('security', ['find-generic-password', '-s', SERVICE(portalId)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const username = /"acct"<blob>="([^"]*)"/.exec(dump)?.[1] ?? '';
    if (!password) return null;
    secret(password);
    return { username, password };
  } catch (error) {
    if (error?.status === NOT_FOUND) return null; // expected: nothing saved for this site.
    if (error?.code === 'ENOENT') {
      throw new Failure('signin.keychain_unavailable', undefined, { portalId });
    }
    note('keychain.refused', { portalId, status: error?.status ?? null });
    throw new Failure('signin.keychain_declined', undefined, {
      portalId,
      status: error?.status ?? null,
    });
  }
}

/** Whether a sign-in is remembered, without unlocking it. */
export function hasCredentials(portalId) {
  if (!keychainAvailable()) return false;
  try {
    execFileSync('security', ['find-generic-password', '-s', SERVICE(portalId)], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    // expected: not found (or not readable), which is what "no" means here.
    return false;
  }
}

export function clearCredentials(portalId) {
  if (!keychainAvailable()) return false;
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE(portalId)], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    // expected: there was nothing to delete.
    return false;
  }
}

/**
 * The saved sign-in for a background job that can carry on without one.
 *
 * A sync whose session cookies still work does not need the keychain at all,
 * so a refused keychain prompt must not stop it -- it is noted, and reported as
 * the reason if the site does turn out to want a sign-in.
 *
 * @returns {{ creds: { username: string, password: string } | null,
 *   refused: 'signin.keychain_declined' | 'signin.keychain_unavailable' | null }}
 */
export function savedSignIn(portalId, options) {
  try {
    return { creds: readCredentials(portalId, options), refused: null };
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    note('keychain.carrying_on_without', { portalId, code: error.code });
    return { creds: null, refused: error.code };
  }
}
