import { describe, expect, it } from 'vitest';
import { userAgentFor } from './site-session.mjs';

/**
 * Google's sign-in page refuses a browser that names itself Electron, and an
 * embedded-app token draws the same refusal. Everything else in the string is
 * an ordinary Chrome on this OS and must survive untouched: what is left has
 * to be true, or this would be a spoof rather than a declining to lie.
 */
describe('userAgentFor', () => {
  const CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  const ELECTRON =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) ContextoAgent/0.0.0 Chrome/153.0.0.0 Electron/39.8.10 Safari/537.36';

  it('strips the Electron token', () => {
    expect(userAgentFor(ELECTRON)).not.toMatch(/Electron/);
  });

  it('strips the app-name token', () => {
    expect(userAgentFor(ELECTRON)).not.toMatch(/ContextoAgent/);
  });

  it('leaves an already-clean Chrome string unchanged', () => {
    expect(userAgentFor(CHROME)).toBe(CHROME);
  });

  it('keeps the Chrome and Safari tokens and single-spaces the result', () => {
    expect(userAgentFor(ELECTRON)).toBe(CHROME);
  });
});
