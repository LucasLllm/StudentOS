import { describe, expect, it } from 'vitest';
import {
  clearCredentials,
  hasCredentials,
  keychainAvailable,
  readCredentials,
  saveCredentials,
} from './credentials.mjs';

/**
 * A student's school password is the most sensitive thing this app touches.
 * These pin where it lives and, just as importantly, where it does not.
 */
describe('saved sign-ins', () => {
  const site = 'vitest-credentials-probe';

  it.runIf(keychainAvailable())('round-trips through the keychain', () => {
    saveCredentials(site, { username: 'student@lcc.ca', password: 'correct horse battery staple' });
    try {
      expect(hasCredentials(site)).toBe(true);
      const read = readCredentials(site);
      expect(read?.username).toBe('student@lcc.ca');
      expect(read?.password).toBe('correct horse battery staple');
    } finally {
      clearCredentials(site);
    }
  });

  it.runIf(keychainAvailable())('forgets on request, completely', () => {
    saveCredentials(site, { username: 'a', password: 'b' });
    expect(clearCredentials(site)).toBe(true);
    expect(hasCredentials(site)).toBe(false);
    expect(readCredentials(site)).toBeNull();
  });

  it('reports no saved sign-in rather than throwing when there is none', () => {
    // A site without one is the normal case, not a fault.
    expect(readCredentials('vitest-definitely-not-saved')).toBeNull();
    expect(hasCredentials('vitest-definitely-not-saved')).toBe(false);
  });

  it.runIf(keychainAvailable())('refuses a half-filled sign-in', () => {
    expect(() => saveCredentials(site, { username: 'only-a-name', password: '' })).toThrow();
    expect(() => saveCredentials(site, { username: '', password: 'only-a-password' })).toThrow();
    expect(hasCredentials(site)).toBe(false);
  });

  it('keeps sites separate', () => {
    if (!keychainAvailable()) return;
    saveCredentials(`${site}-one`, { username: 'one', password: 'p1' });
    saveCredentials(`${site}-two`, { username: 'two', password: 'p2' });
    try {
      expect(readCredentials(`${site}-one`)?.password).toBe('p1');
      expect(readCredentials(`${site}-two`)?.password).toBe('p2');
    } finally {
      clearCredentials(`${site}-one`);
      clearCredentials(`${site}-two`);
    }
  });
});

describe('when the keychain will not answer', () => {
  const failing = (status, code) => () => {
    const error = new Error('security failed');
    if (status !== undefined) error.status = status;
    if (code) error.code = code;
    throw error;
  };

  it.runIf(keychainAvailable())('treats "not found" as nothing saved', () => {
    expect(readCredentials('x', { exec: failing(44) })).toBeNull();
  });

  it.runIf(keychainAvailable())(
    'says so when the keychain refused, instead of "nothing saved"',
    () => {
      expect(() => readCredentials('x', { exec: failing(128) })).toThrow(
        expect.objectContaining({ code: 'signin.keychain_declined' }),
      );
    },
  );

  it.runIf(keychainAvailable())('says so when the keychain tool is missing', () => {
    expect(() => readCredentials('x', { exec: failing(undefined, 'ENOENT') })).toThrow(
      expect.objectContaining({ code: 'signin.keychain_unavailable' }),
    );
  });
});
