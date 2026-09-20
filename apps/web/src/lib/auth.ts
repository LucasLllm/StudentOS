import { createAuthClient } from 'better-auth/react';
import { API_BASE_URL } from './env.js';
import { connectReturnUrl } from './connectReturn.js';

/**
 * Auth client.
 *
 * `credentials: 'include'` is what sends the session cookie cross-origin
 * (the SPA and API are on different ports in dev, and likely different
 * subdomains in production).
 *
 * TODO(desktop): the Mac shell will need the bearer-token path instead of
 * cookies -- store the token in the OS keychain and set an Authorization
 * header here. The API already accepts both (see apps/api/src/auth.ts).
 */
export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  fetchOptions: {
    credentials: 'include',
  },
});

export const { useSession, signIn, signOut, linkSocial } = authClient;

/** Sign in with Google, requesting identity scopes only. */
export function signInWithGoogle() {
  return signIn.social({
    provider: 'google',
    /*
     * Back to the page they were on, not the front door. A student who first
     * meets this app by clicking "Link this computer" is sent to Google from
     * /link/<id>; returning them to / would strand them on the agent list
     * while the desktop app sits polling for an approval that never comes.
     */
    callbackURL: window.location.href,
  });
}

/**
 * Grant an additional Google scope group.
 *
 * `scopes` must be the UNION of everything already granted plus the new group,
 * which is why it comes from the server (GET /google/connect-scopes/:group)
 * rather than being hardcoded here. Requesting only the new group's scopes
 * returns a token that no longer covers the old ones -- see the comment on
 * that route.
 */
export function connectGoogleScopes(scopes: string[]) {
  /*
   * Back to Settings, open on Connections -- not to the page they were on.
   * Settings is a window over the conversation, so the current address is
   * the chat underneath it, and returning there closed the window and left
   * them to find out for themselves whether anything had connected. The
   * same address for Google's no: without it, Better Auth shows its own
   * error page and the student's way back is the browser's Back button.
   */
  const here = connectReturnUrl(window.location.origin);
  return linkSocial({
    provider: 'google',
    scopes,
    callbackURL: here,
    errorCallbackURL: here,
  });
}
