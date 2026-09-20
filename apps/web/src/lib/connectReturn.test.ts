import { describe, expect, it } from 'vitest';
import { connectErrorFromSearch, connectReturnUrl, sectionFromSearch } from './connectReturn.js';

describe('where Google sends a student back', () => {
  it('is Settings, open on Connections', () => {
    expect(connectReturnUrl('https://contextoagent.ai')).toBe(
      'https://contextoagent.ai/settings?section=connections',
    );
  });

  it('names the section to open, and nothing when the address does not say', () => {
    expect(sectionFromSearch('?section=connections')).toBe('Connections');
    expect(sectionFromSearch('?section=connections&error=access_denied')).toBe('Connections');
    expect(sectionFromSearch('')).toBeNull();
    expect(sectionFromSearch('?section=general')).toBeNull();
  });
});

describe("Google's no, read off the address", () => {
  it('is nothing when Google said yes', () => {
    expect(connectErrorFromSearch('?section=connections')).toBeNull();
    expect(connectErrorFromSearch('')).toBeNull();
  });

  it('says the permission screen was closed early', () => {
    expect(connectErrorFromSearch('?section=connections&error=access_denied')).toBe(
      "Nothing was connected: Google's permission screen was closed before the end.",
    );
  });

  it('says a different Google account was chosen', () => {
    expect(connectErrorFromSearch("?error=email_doesn't_match")).toBe(
      'That was a different Google account. Choose the one you signed in with.',
    );
  });

  it('carries an unfamiliar code rather than hiding it', () => {
    expect(connectErrorFromSearch('?error=invalid_code')).toBe(
      'Google could not finish connecting (invalid_code). Try again.',
    );
  });
});
