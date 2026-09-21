const { contextBridge, ipcRenderer } = require('electron');

/**
 * What the hosted web app gains by running inside the desktop app.
 *
 * The web app is loaded from contextoagent.ai and is otherwise exactly the
 * page a browser would show. This bridge is the difference: in the app, the
 * Sites section can actually add and sign into a site, because there is a
 * real browser on this machine to drive. In a browser tab the same section
 * offers the download instead, because nothing else is possible there.
 *
 * Named calls only, and no way to reach the device token or the filesystem.
 * The page is our own origin, but it is still remote content and is treated
 * as such.
 */
contextBridge.exposeInMainWorld('contextoDesktop', {
  version: 1,
  status: () => ipcRenderer.invoke('status'),
  signIn: () => ipcRenderer.invoke('signIn'),
  listSites: () => ipcRenderer.invoke('status').then((r) => (r.ok ? r.value.portals : [])),
  addSite: (site) => ipcRenderer.invoke('addPortal', site),
  removeSite: (id) => ipcRenderer.invoke('removePortal', id),
  syncSite: (id) => ipcRenderer.invoke('syncPortal', id),
  saveCredentials: (id, creds) => ipcRenderer.invoke('saveCredentials', id, creds),
  hasCredentials: (id) => ipcRenderer.invoke('hasCredentials', id),
  clearCredentials: (id) => ipcRenderer.invoke('clearCredentials', id),
  autoSignIn: (id) => ipcRenderer.invoke('autoSignIn', id),
  // Where to put the browser the agent is driving. The page owns the layout;
  // the main process owns what is inside it.
  setSiteViewBounds: (bounds) => ipcRenderer.invoke('siteViewBounds', bounds),
  /*
   * Both hand back a way to stop listening. Without one, every conversation
   * a student opens leaves another listener behind for the life of the
   * window, all of them still holding the panel that has since gone.
   */
  onSiteSession: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('site-session', handler);
    return () => ipcRenderer.removeListener('site-session', handler);
  },
  onSiteViewClick: (fn) => {
    const handler = () => fn();
    ipcRenderer.on('site-view-clicked', handler);
    return () => ipcRenderer.removeListener('site-view-clicked', handler);
  },
  /** A still of the page the agent is on, after each step. The site cannot send this. */
  onSiteFrame: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('site-frame', handler);
    return () => ipcRenderer.removeListener('site-frame', handler);
  },
  getSiteSession: () => ipcRenderer.invoke('siteSession'),
  onSitesChanged: (fn) => ipcRenderer.on('portals-changed', () => fn()),
});
