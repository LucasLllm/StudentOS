import { Fragment, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { connectGoogleScopes } from '../lib/auth.js';
import { connectErrorFromSearch } from '../lib/connectReturn.js';
import { ClassroomLogo, DriveLogo, GmailLogo, SparkMark } from './ConnectionLogos.js';
import { Row } from './SettingsRow.js';
import { Toggle } from './Toggle.js';

type Group = 'classroom' | 'drive' | 'gmail';

type Status = {
  classroom: boolean;
  drive: boolean;
  gmail: boolean;
  disabled: string[];
  missing: { classroom: string[]; gmail: string[] };
};

const CONNECTIONS: { group: Group; name: string; logo: React.ReactNode }[] = [
  { group: 'classroom', name: 'Classroom', logo: <ClassroomLogo /> },
  { group: 'drive', name: 'Drive', logo: <DriveLogo /> },
  { group: 'gmail', name: 'Gmail', logo: <GmailLogo /> },
];

/**
 * Google connections.
 *
 * One row per integration, and one decision per row. The write half of each
 * -- turning work in, sending mail -- comes with the connection rather than
 * as a second switch: a student connects Gmail or does not, and the switch
 * takes reading and sending off together.
 */
export function GoogleConnections() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await api.google.status.$get();
    if (res.ok) setStatus((await res.json()) as Status);
  }

  useEffect(() => {
    void load();

    /*
     * Google's no arrives on the address (see lib/connectReturn.ts). Shown
     * once, then taken off it, so a refresh is not told the same thing again.
     */
    const refused = connectErrorFromSearch(window.location.search);
    if (refused) {
      setError(refused);
      const url = new URL(window.location.href);
      url.searchParams.delete('error');
      url.searchParams.delete('error_description');
      window.history.replaceState({}, '', url);
    }
  }, []);

  /*
   * Back, pressed on Google's screen, can bring this page out of the browser's
   * cache exactly as it was left: "Opening…", every button disabled. Nothing
   * is opening any more, so the buttons come back. A fresh load fires the
   * same event with nothing to undo.
   */
  useEffect(() => {
    const shown = () => setBusy(null);
    window.addEventListener('pageshow', shown);
    return () => window.removeEventListener('pageshow', shown);
  }, []);

  async function connect(group: Group | 'all') {
    setBusy(group);
    setError(null);
    try {
      // The server decides the scope list, because it has to include what is
      // already granted -- see lib/auth.ts.
      const res = await api.google['connect-scopes'][':group'].$get({
        param: { group },
        query: {},
      });
      if (!res.ok) throw new Error('Could not work out which permissions to request.');

      const body = await res.json();
      if (!('scopes' in body)) throw new Error('Unexpected response.');

      // Redirects to Google. Execution stops here on success.
      await connectGoogleScopes(body.scopes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unknown error');
      setBusy(null);
    }
  }

  async function toggle(group: Group, enabled: boolean) {
    // Optimistic: the switch moves now, and the server catches up.
    setStatus((prev) =>
      prev
        ? {
            ...prev,
            disabled: enabled
              ? prev.disabled.filter((d) => d !== group)
              : [...new Set([...prev.disabled, group])],
          }
        : prev,
    );
    setError(null);

    const res = await api.google.integrations[':group'].$put({
      param: { group },
      json: { enabled },
    });
    if (!res.ok) {
      setError('Could not save that change.');
      void load();
    }
  }

  if (!status) return null;

  const isOn = (group: Group) => !status.disabled.includes(group);
  const allConnected = CONNECTIONS.every(({ group }) => status[group]);
  /* A school that approved a subset. Reconnecting asks Google for the rest. */
  const incomplete = (group: Group) => group !== 'drive' && status.missing[group].length > 0;

  return (
    <>
      <h2 className="settings-heading">Connections</h2>

      {/*
       * One tap for the whole product, before the list of parts. Someone
       * setting this up for the first time wants their agent to work, not to
       * make three separate permission decisions before it does anything.
       */}
      {!allConnected && (
        <>
          <div className="connect-all">
            {/* The glow is on the wrapper; the card sits above it. See the CSS. */}
            <div className="connect-all-card">
              <span className="settings-icon" aria-hidden="true">
                <SparkMark />
              </span>
              <div className="settings-label">
                <span>
                  Connect everything
                  <span className="recommended">Recommended</span>
                </span>
              </div>
              <div className="settings-control">
                <button
                  className="primary"
                  disabled={busy !== null}
                  onClick={() => void connect('all')}
                >
                  {busy === 'all' ? 'Opening…' : 'Connect'}
                </button>
              </div>
            </div>
          </div>
          {/*
           * The scopes are unverified with Google (see the note in
           * packages/agent/src/tools/google/scopes.ts), so Google's screen
           * leads with "Back to safety". A first-time student takes that
           * exit, comes back here, and finds nothing connected -- the way
           * through is a small link Google does not draw attention to.
           */}
          <p className="settings-note">
            If Google warns that this app is not verified, choose <strong>Advanced</strong> and
            continue anyway.
          </p>
        </>
      )}

      {CONNECTIONS.map(({ group, name, logo }) => (
        <Fragment key={group}>
          <Row icon={logo} label={name}>
            {status[group] ? (
              <>
                {incomplete(group) && (
                  <button
                    className="quiet"
                    disabled={busy !== null}
                    onClick={() => void connect(group)}
                  >
                    {busy === group ? 'Opening…' : 'Reconnect'}
                  </button>
                )}
                <Toggle
                  label={`${name} enabled`}
                  checked={isOn(group)}
                  onChange={(next) => void toggle(group, next)}
                />
              </>
            ) : (
              <button disabled={busy !== null} onClick={() => void connect(group)}>
                {busy === group ? 'Opening…' : 'Connect'}
              </button>
            )}
          </Row>

          {/*
           * Classroom hands back the NAME and link of every attachment but
           * not a word of what is inside it -- reading a file is Drive's
           * job. Switched off counts as missing: the tools are deregistered
           * either way, so the student sees the same behaviour.
           */}
          {group === 'classroom' && status.classroom && (!status.drive || !isOn('drive')) && (
            <p className="notice">
              Without <strong>Drive</strong>, your agent can see your assignments and the names of
              the files your teachers post, but not what is in them.
            </p>
          )}
        </Fragment>
      ))}

      {error && <p className="settings-note">{error}</p>}
    </>
  );
}
