/**
 * The desktop app, when we are running inside it.
 *
 * The same page is served to a browser tab and to the desktop app. Only the
 * app can sign into another site -- it has a real browser on the machine to
 * drive -- so the Sites section asks here whether that is possible, rather
 * than the two builds diverging.
 */
export interface LocalSite {
  id: string;
  name: string;
  url: string;
  origin: string;
  loggedInAt?: string | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
}

export interface DesktopBridge {
  version: number;
  signIn?(): Promise<{ ok: boolean; value?: { via: string }; error?: string }>;
  listSites(): Promise<LocalSite[]>;
  addSite(site: { name: string; url: string; username: string; password: string }): Promise<{
    ok: boolean;
    value?: { signedIn?: boolean; synced?: boolean; reason?: string };
    error?: string;
  }>;
  removeSite(id: string): Promise<{ ok: boolean; error?: string }>;
  beginLogin(id: string): Promise<{ ok: boolean; error?: string }>;
  finishLogin(
    id: string,
  ): Promise<{ ok: boolean; value?: { needsLogin?: boolean }; error?: string }>;
  syncSite(id: string): Promise<{ ok: boolean; error?: string }>;
  saveCredentials?(
    id: string,
    creds: { username: string; password: string },
  ): Promise<{ ok: boolean; error?: string }>;
  hasCredentials?(
    id: string,
  ): Promise<{ ok: boolean; value?: { saved: boolean; available: boolean } }>;
  clearCredentials?(id: string): Promise<{ ok: boolean }>;
  autoSignIn?(
    id: string,
  ): Promise<{ ok: boolean; value?: { ok?: boolean; reason?: string }; error?: string }>;
  onSitesChanged(fn: () => void): void;
  setSiteViewBounds?(
    bounds: { x: number; y: number; width: number; height: number } | null,
  ): Promise<unknown>;
  /*
   * These hand back a way to stop listening. An app built before they did
   * returns nothing, which is why the callers treat it as optional -- the
   * page is served to whatever version of the app is installed.
   */
  onSiteSession?(
    fn: (payload: {
      active: boolean;
      showing?: boolean;
      portalId?: string;
      agentId?: string | null;
    }) => void,
  ): (() => void) | undefined;
  /** A click landed on the browser view. The site itself cannot send this. */
  onSiteViewClick?(fn: () => void): (() => void) | undefined;
  /** A still of the page the agent is on, after each step. The site cannot send this. */
  onSiteFrame?(
    fn: (payload: {
      agentId?: string | null;
      portalId?: string;
      title?: string;
      url?: string;
      frame: string;
    }) => void,
  ): (() => void) | undefined;
  /** What is on screen now. Asked on mount, so leaving a chat does not lose it. */
  getSiteSession?(): Promise<{
    ok: boolean;
    value?: {
      active: boolean;
      showing: boolean;
      portalId: string | null;
      agentId: string | null;
      /** The last still sent, when there is a browser to have taken it of. */
      frame?: string | null;
    };
  }>;
}

declare global {
  interface Window {
    contextoDesktop?: DesktopBridge;
  }
}

export function desktop(): DesktopBridge | null {
  return typeof window !== 'undefined' ? (window.contextoDesktop ?? null) : null;
}
