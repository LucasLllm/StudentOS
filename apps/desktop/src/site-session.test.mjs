import { describe, expect, it } from 'vitest';
import { userAgentFor } from './site-session.mjs';

/**
 * Measured, 21 September 2026, on Google's sign-in page from this view with
 * the debugger released and input by the window's own path: a Chrome string
 * with the Electron and app tokens removed is still answered "This browser or
 * app may not be secure"; a Firefox string for the same platform is let
 * through to the ordinary next step. So the profile presents as Firefox, and
 * never as Electron or as the app.
 */
describe('userAgentFor', () => {
  it('presents as Firefox on a Mac', () => {
    const ua = userAgentFor('darwin');
    expect(ua).toMatch(
      /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10\.15; rv:\d+\.0\) Gecko\/20100101 Firefox\/\d+\.0$/,
    );
  });

  it('presents as Firefox on Windows', () => {
    expect(userAgentFor('win32')).toMatch(
      /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64; rv:\d+\.0\) Gecko\/20100101 Firefox\/\d+\.0$/,
    );
  });

  it('presents as Firefox on Linux', () => {
    expect(userAgentFor('linux')).toMatch(
      /^Mozilla\/5\.0 \(X11; Linux x86_64; rv:\d+\.0\) Gecko\/20100101 Firefox\/\d+\.0$/,
    );
  });

  it('never names Electron, the app, or Chrome', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const ua = userAgentFor(platform);
      expect(ua).not.toMatch(/Electron|ContextoAgent|Chrome|Safari/);
    }
  });
});
