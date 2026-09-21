/**
 * Tell Google which account a connect is for.
 *
 * Better Auth's link-social builds the Google authorization URL with no
 * login_hint, and this version cannot be asked to add one, so Google runs its
 * consent screen for whichever account is active in the student's browser. A
 * student signed into the app as one Google account, with a second -- often
 * their school account -- also logged into the same browser, consents as the
 * wrong one. The callback then finds that account's email does not match the
 * one they are signed in as and rejects the whole thing (email_doesn't_match),
 * landing them back on Settings with nothing connected. It is intermittent
 * because it turns on which Google account happens to be active.
 *
 * Passing the signed-in email as login_hint points Google at the one account
 * the link is allowed to be, so the mismatch cannot arise. A student not
 * already in that account is asked to sign into it, which is the right outcome.
 */
export function withGoogleLoginHint(
  location: string | null,
  email: string | null | undefined,
): string | null {
  if (!location || !email) return location;
  if (!location.startsWith('https://accounts.google.com/')) return location;
  const url = new URL(location);
  // Never override a hint that is already present.
  if (url.searchParams.has('login_hint')) return location;
  url.searchParams.set('login_hint', email);
  return url.toString();
}

/**
 * Apply the login_hint to a Better Auth auth-URL response.
 *
 * Better Auth returns the Google URL in TWO places: the Location header and a
 * JSON body `{ url }`. The web client redirects to the body's url, so hinting
 * only the header would change nothing the browser follows -- both are set.
 * Only redirects to Google with a known account are touched; everything else,
 * including a first sign-in that has no session, is passed straight through.
 */
export async function hintGoogleAuthResponse(
  res: Response,
  email: string | null | undefined,
): Promise<Response> {
  const location = res.headers.get('location');
  if (!location?.startsWith('https://accounts.google.com/') || !email) return res;

  const hintedLocation = withGoogleLoginHint(location, email);
  if (hintedLocation === location) return res;

  const headers = new Headers(res.headers);
  headers.set('location', hintedLocation!);

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { url?: unknown } | null;
    if (body && typeof body.url === 'string') {
      const hinted = { ...body, url: withGoogleLoginHint(body.url, email) ?? body.url };
      return new Response(JSON.stringify(hinted), { status: res.status, headers });
    }
  }
  return new Response(res.body, { status: res.status, headers });
}
