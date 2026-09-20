/**
 * Coming back from Google.
 *
 * Settings is a window over the conversation, not an address, so the page a
 * student pressed Connect on says nothing about it in the URL. Sending Google
 * back to wherever they were dropped them into the chat with the window shut
 * and nothing said -- whether the connection took or not -- and the only way
 * to find out was to open Settings again and look. This is the one address
 * that reopens the window on the right section, and it doubles as where
 * Google's no is delivered: Better Auth appends `?error=<code>` to it.
 */
export function connectReturnUrl(origin: string): string {
  return `${origin}/settings?section=connections`;
}

/** The Settings section the address asks for, if it asks for one. */
export function sectionFromSearch(search: string): 'Connections' | null {
  return new URLSearchParams(search).get('section') === 'connections' ? 'Connections' : null;
}

/*
 * The codes Better Auth's OAuth callback redirects with, in words a student
 * can act on. Google's own `access_denied` is the one that happens by hand:
 * Cancel, or the browser closed, on the permission screen.
 */
const EXPLAINED: Record<string, string> = {
  access_denied: "Nothing was connected: Google's permission screen was closed before the end.",
  "email_doesn't_match": 'That was a different Google account. Choose the one you signed in with.',
  account_already_linked_to_different_user:
    'That Google account already belongs to another Contexto account.',
  // Google's answer arrived after the ten minutes the request is good for.
  state_mismatch: "That took too long, so Google's answer no longer counted. Try again.",
  state_security_mismatch: "That took too long, so Google's answer no longer counted. Try again.",
};

/** What Google's no means, read off the address. Null when there was no no. */
export function connectErrorFromSearch(search: string): string | null {
  const code = new URLSearchParams(search).get('error');
  if (!code) return null;
  return EXPLAINED[code] ?? `Google could not finish connecting (${code}). Try again.`;
}
