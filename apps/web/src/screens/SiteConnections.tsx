import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { desktop, type LocalSite } from '../lib/desktop.js';
import { MAC_DOWNLOAD } from '../lib/download.js';
import { SiteLogo } from './ConnectionLogos.js';
import { Row } from './SettingsRow.js';
import { Toggle } from './Toggle.js';

export interface ServerSite {
  portalId: string;
  origin: string;
  capturedAt: string;
  enabled: boolean;
  needsLogin: boolean;
  pages: number;
}

export interface Row {
  id: string;
  label: string;
  /** Where it lives, for its logo. */
  origin: string;
  detail: string;
  enabled: boolean;
  signedIn: boolean;
}

export function merge(server: ServerSite[], local: LocalSite[]): Row[] {
  const byId = new Map<string, Row>();

  for (const site of server) {
    byId.set(site.portalId, {
      id: site.portalId,
      label: site.origin.replace(/^https?:\/\//, ''),
      origin: site.origin,
      detail: site.needsLogin
        ? 'needs signing in again'
        : site.pages === 0
          ? 'nothing published yet'
          : `${site.pages} page${site.pages === 1 ? '' : 's'}`,
      enabled: site.enabled,
      signedIn: !site.needsLogin,
    });
  }

  // A site added in the app but never synced exists only on this machine, so
  // the server list alone would show nothing and look broken.
  for (const site of local) {
    const existing = byId.get(site.id);
    const signedIn = Boolean(site.loggedInAt);
    if (existing) {
      byId.set(site.id, { ...existing, signedIn: existing.signedIn && signedIn });
      continue;
    }
    byId.set(site.id, {
      id: site.id,
      label: site.name,
      origin: site.origin,
      detail: signedIn ? 'signed in, not synced yet' : 'not signed in yet',
      enabled: true,
      signedIn,
    });
  }

  return [...byId.values()];
}

/**
 * Sites behind a login.
 *
 * The same component in both places. In the desktop app it can add and sign
 * into a site, because there is a real browser on the machine to drive; in a
 * browser tab it offers the download instead, because nothing else is
 * possible there -- a page cannot sign into another site on your behalf.
 */
export function SiteConnections() {
  const bridge = desktop();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [creds, setCreds] = useState({ username: '', password: '' });
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');

  async function load() {
    const res = await api.devices.sites.$get();
    const server: ServerSite[] = res.ok ? await res.json() : [];
    const local = bridge ? await bridge.listSites() : [];
    setRows(merge(server, local));

    if (bridge?.hasCredentials) {
      const flags: Record<string, boolean> = {};
      for (const site of local) {
        const result = await bridge.hasCredentials(site.id);
        flags[site.id] = Boolean(result.ok && result.value?.saved);
      }
      setSaved(flags);
    }
  }

  useEffect(() => {
    void load();
    // The bridge is a window property, fixed for the lifetime of the page.
    bridge?.onSitesChanged(() => void load());
  }, []);

  async function setEnabled(row: Row, enabled: boolean) {
    setBusy(row.id);
    await api.devices.sites[':portalId'].enabled.$post({
      param: { portalId: row.id },
      json: { enabled },
    });
    await load();
    setBusy(null);
  }

  async function remove(row: Row) {
    if (!confirm(`Remove ${row.label}? What it has read will be deleted.`)) return;
    setBusy(row.id);
    await api.devices.sites[':portalId'].$delete({ param: { portalId: row.id } });
    await bridge?.removeSite(row.id);
    await load();
    setBusy(null);
  }

  async function rememberSignIn(portalId: string) {
    if (!bridge?.saveCredentials) return;
    if (!creds.username.trim() || !creds.password) return alert('Both fields are needed.');
    setBusy(portalId);
    const result = await bridge.saveCredentials(portalId, {
      username: creds.username.trim(),
      password: creds.password,
    });
    // Cleared from the page as soon as it is handed over -- there is no reason
    // for a password to sit in a form once the keychain has it.
    setCreds({ username: '', password: '' });
    setEditing(null);
    setBusy(null);
    if (!result.ok) return alert(result.error ?? 'Could not save that sign-in.');
    await load();
  }

  async function forgetSignIn(row: Row) {
    if (!bridge?.clearCredentials) return;
    if (!confirm(`Forget the saved sign-in for ${row.label}?`)) return;
    setBusy(row.id);
    await bridge.clearCredentials(row.id);
    await load();
    setBusy(null);
  }

  async function add() {
    if (!bridge) return;
    if (!name.trim() || !url.trim()) return alert('A name and address are needed.');
    if (!creds.username.trim() || !creds.password)
      return alert('A username and password are needed.');

    setBusy('add');
    const added = await bridge.addSite({
      name: name.trim(),
      url: url.trim(),
      username: creds.username.trim(),
      password: creds.password,
    });
    // Cleared as soon as it is handed over. There is no reason for a password
    // to sit in a form once the keychain has it.
    setCreds({ username: '', password: '' });
    setBusy(null);

    if (!added.ok) return alert(added.error ?? 'Could not add that site.');
    setName('');
    setUrl('');
    await load();

    // Adding now includes signing in, so say which of the three things
    // happened rather than leaving a row that looks added but never fetched.
    if (added.value && added.value.signedIn === false) {
      alert(
        `Added ${name.trim()}, but that sign-in did not work: ${added.value.reason ?? 'the site refused it'}.\n\n` +
          'If the site signs in through Google, sign in once in the browser card in a conversation and it stays signed in.',
      );
    }
  }

  return (
    <>
      <h2 className="settings-heading">Custom sites</h2>
      {!bridge && <p className="settings-intro">Added from the desktop app.</p>}

      {rows.map((row) => (
        <Row
          key={row.id}
          icon={<SiteLogo origin={row.origin} name={row.label} />}
          label={row.label}
          hint={row.detail}
        >
          <Toggle
            checked={row.enabled}
            disabled={busy === row.id}
            label={`Let your agent read ${row.label}`}
            onChange={(next) => void setEnabled(row, next)}
          />
          {bridge?.saveCredentials &&
            (saved[row.id] ? (
              <button disabled={busy === row.id} onClick={() => void forgetSignIn(row)}>
                Forget sign-in
              </button>
            ) : (
              <button
                disabled={busy === row.id}
                onClick={() => {
                  setEditing(row.id);
                  setCreds({ username: '', password: '' });
                }}
              >
                Save sign-in
              </button>
            ))}
          <button disabled={busy === row.id} onClick={() => void remove(row)}>
            Remove
          </button>
        </Row>
      ))}

      {editing && (
        <div className="saved-signin">
          <p className="muted small">
            Kept in your Mac&rsquo;s keychain on this computer. It is never sent to Contexto Agent,
            and works for sites with a normal username and password. For a site behind Google, sign
            in once in the browser card in a conversation and it stays signed in.
          </p>
          <div className="add-site">
            <input
              value={creds.username}
              onChange={(e) => setCreds({ ...creds, username: e.target.value })}
              placeholder="Username"
              aria-label="Username"
              autoComplete="off"
            />
            <input
              type="password"
              value={creds.password}
              onChange={(e) => setCreds({ ...creds, password: e.target.value })}
              placeholder="Password"
              aria-label="Password"
              autoComplete="new-password"
            />
            <button className="primary" onClick={() => void rememberSignIn(editing)}>
              Save
            </button>
            <button
              onClick={() => {
                setEditing(null);
                setCreds({ username: '', password: '' });
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {bridge ? (
        <div className="saved-signin">
          <p className="muted small">
            Your sign-in is kept in this Mac&rsquo;s keychain and never sent to Contexto Agent. It
            works for sites with a normal username and password. For a site behind Google, sign in
            once in the browser card in a conversation and it stays signed in.
          </p>
          <div className="add-site">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Veracross"
              aria-label="Site name"
            />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://portals.veracross.com/lcc/student"
              aria-label="Site address"
            />
          </div>
          <div className="add-site">
            <input
              value={creds.username}
              onChange={(e) => setCreds({ ...creds, username: e.target.value })}
              placeholder="Username"
              aria-label="Username"
              autoComplete="off"
            />
            <input
              type="password"
              value={creds.password}
              onChange={(e) => setCreds({ ...creds, password: e.target.value })}
              placeholder="Password"
              aria-label="Password"
              autoComplete="new-password"
            />
            <button className="primary" disabled={busy === 'add'} onClick={() => void add()}>
              {busy === 'add' ? 'Signing in\u2026' : 'Add and sign in'}
            </button>
          </div>
        </div>
      ) : (
        <Row label="Contexto Agent for Mac">
          <a className="button blue" href={MAC_DOWNLOAD}>
            Download for macOS
          </a>
        </Row>
      )}
    </>
  );
}
