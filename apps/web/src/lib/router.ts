import { useEffect, useState } from 'react';

/**
 * A router for four screens.
 *
 * Deliberately not react-router. This app has three paths and no nested
 * layouts, and the History API covers that in about forty lines -- a
 * dependency here would be more code to reason about, not less.
 *
 * What routing actually buys, and why it was worth doing: a refresh no longer
 * throws the student back to a blank chat mid-conversation, the browser back
 * button works, and a chat has a URL that can be reopened. On a phone, where
 * this is mostly used, back is a system gesture rather than a button on the
 * page -- so before this, the natural way out of a chat left the app entirely.
 */

export type Route =
  | { name: 'new' }
  | { name: 'chat'; agentId: string }
  | { name: 'projects' }
  | { name: 'project'; projectId: string }
  | { name: 'settings' }
  | { name: 'link'; requestId: string }
  | { name: 'notFound' };

export function parseRoute(pathname: string): Route {
  const segments = pathname.replace(/\/+$/, '').split('/').filter(Boolean);

  if (segments.length === 0) return { name: 'new' };
  if (segments[0] === 'settings' && segments.length === 1) return { name: 'settings' };

  if (segments[0] === 'projects') {
    if (segments.length === 1) return { name: 'projects' };
    if (segments.length === 2 && segments[1]) {
      return { name: 'project', projectId: safeDecode(segments[1]) };
    }
  }

  // Opened by the desktop app in the student's browser, so this arrives from
  // outside the SPA and must survive a cold load.
  if (segments[0] === 'link' && segments.length === 2 && segments[1]) {
    return { name: 'link', requestId: safeDecode(segments[1]) };
  }

  /*
   * `chats` is the address a chat has. `agents` is the address it used to
   * have, still parsed and never generated: the word is gone from the product,
   * but links to it are in browser histories, in the desktop app and in
   * whatever a student has sent themselves. Dropping it would break those to
   * save four lines.
   */
  if (segments[0] === 'chats' || segments[0] === 'agents') {
    if (segments.length === 1) return { name: 'new' };
    /*
     * Decoded, because routeToPath encodes. Ids are UUIDs today so nothing
     * needs escaping, but a router whose parse does not invert its own format
     * is a trap for whoever changes the id scheme later.
     *
     * The id still comes from the URL bar and may be anything at all, so the
     * screen using it must treat an unknown id as "not found", not a crash.
     */
    if (segments.length === 2 && segments[1]) {
      return { name: 'chat', agentId: safeDecode(segments[1]) };
    }
  }

  return { name: 'notFound' };
}

/** A malformed escape must not throw and blank the app. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function routeToPath(route: Route): string {
  switch (route.name) {
    case 'new':
      return '/';
    case 'chat':
      return `/chats/${encodeURIComponent(route.agentId)}`;
    case 'projects':
      return '/projects';
    case 'project':
      return `/projects/${encodeURIComponent(route.projectId)}`;
    case 'settings':
      return '/settings';
    case 'link':
      return `/link/${encodeURIComponent(route.requestId)}`;
    default:
      return '/';
  }
}

/** Navigate, adding a history entry so Back returns to the previous screen. */
export function navigate(route: Route): void {
  const path = routeToPath(route);
  if (path === window.location.pathname) return;
  window.history.pushState({}, '', path);
  // pushState fires no event of its own, so listeners need telling.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** The current route, kept in step with the address bar and the Back button. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  return route;
}
