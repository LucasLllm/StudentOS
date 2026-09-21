import { describe, expect, it } from 'vitest';
import { hintGoogleAuthResponse, withGoogleLoginHint } from './login-hint.js';

const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=openid';

describe('withGoogleLoginHint', () => {
  it('names the account a connect must use', () => {
    const out = withGoogleLoginHint(GOOGLE, 'tyler@example.com');
    expect(new URL(out!).searchParams.get('login_hint')).toBe('tyler@example.com');
  });

  it('leaves a redirect that is not to Google alone', () => {
    expect(withGoogleLoginHint('https://contextoagent.ai/settings', 'a@b.com')).toBe(
      'https://contextoagent.ai/settings',
    );
  });

  it('does nothing without a signed-in account (a first sign-in has none)', () => {
    expect(withGoogleLoginHint(GOOGLE, null)).toBe(GOOGLE);
    expect(withGoogleLoginHint(GOOGLE, undefined)).toBe(GOOGLE);
  });

  it('passes a missing location straight through', () => {
    expect(withGoogleLoginHint(null, 'a@b.com')).toBeNull();
  });

  it('never overrides a hint that is already set', () => {
    const withHint = `${GOOGLE}&login_hint=someone@else.com`;
    expect(withGoogleLoginHint(withHint, 'tyler@example.com')).toBe(withHint);
  });
});

describe('hintGoogleAuthResponse', () => {
  // Better Auth returns the Google URL in BOTH the Location header and a JSON
  // body {url}. The web client follows the body url, so both must be hinted.
  const authResponse = () =>
    new Response(JSON.stringify({ url: GOOGLE, redirect: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', location: GOOGLE },
    });

  it('hints the body url the browser actually follows', async () => {
    const out = await hintGoogleAuthResponse(authResponse(), 'tyler@example.com');
    const body = (await out.json()) as { url: string };
    expect(new URL(body.url).searchParams.get('login_hint')).toBe('tyler@example.com');
  });

  it('hints the Location header too', async () => {
    const out = await hintGoogleAuthResponse(authResponse(), 'tyler@example.com');
    expect(new URL(out.headers.get('location')!).searchParams.get('login_hint')).toBe(
      'tyler@example.com',
    );
  });

  it('leaves a non-Google response untouched', async () => {
    const res = new Response(null, {
      status: 302,
      headers: { location: 'https://contextoagent.ai/settings' },
    });
    const out = await hintGoogleAuthResponse(res, 'tyler@example.com');
    expect(out.headers.get('location')).toBe('https://contextoagent.ai/settings');
  });

  it('leaves the response alone when there is no session (first sign-in)', async () => {
    const out = await hintGoogleAuthResponse(authResponse(), null);
    const body = (await out.json()) as { url: string };
    expect(new URL(body.url).searchParams.has('login_hint')).toBe(false);
  });
});
