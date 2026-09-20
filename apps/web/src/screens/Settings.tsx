import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MeProfile, UsageStatus } from '@contexto/shared';
import { api } from '../lib/api.js';
import { applyAppearance, type Appearance } from '../lib/theme.js';
import { forgetGraph, loadGraph } from '../lib/vaultGraph.js';
import { signOut } from '../lib/auth.js';
import { sectionFromSearch } from '../lib/connectReturn.js';
import { initialOf } from '../lib/initial.js';
import { ArchivedChats } from './ArchivedChats.js';
import { DeviceConnections } from './DeviceConnections.js';
import { GoogleConnections } from './GoogleConnections.js';
import { Row } from './SettingsRow.js';
import { SiteConnections } from './SiteConnections.js';
import { UsageBars } from './UsageBars.js';
import { VaultMap } from './VaultMap.js';

/**
 * Settings, as a window over the conversation rather than a place you go.
 *
 * It used to be a screen, which meant leaving the chat to change a name and
 * finding your way back afterwards. Everything in here is a small adjustment
 * to something you were already doing, so it opens over the top and closes
 * again -- the same shape as the delete question, and blurred the same way,
 * so the two read as the same kind of thing.
 *
 * Portalled out of the app for the reason the delete dialog is: the blur is a
 * filter on .app, and a filter makes its element the containing block for
 * anything fixed inside it. A dialog rendered in there would be positioned
 * against the blurred box and blurred along with it.
 */

const SECTIONS = ['General', 'Account', 'Usage', 'Connections', 'Memory'] as const;
type Section = (typeof SECTIONS)[number];

export function Settings({ onClose }: { onClose: () => void }) {
  // Google sends a student back to /settings?section=connections, so the
  // window opens on what they went to Google for rather than on General.
  const [section, setSection] = useState<Section>(
    () => sectionFromSearch(window.location.search) ?? 'General',
  );
  const [me, setMe] = useState<MeProfile | null>(null);

  useEffect(() => {
    document.body.classList.add('dialog-open');
    return () => document.body.classList.remove('dialog-open');
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    void (async () => {
      const res = await api.me.$get();
      if (res.ok) setMe((await res.json()) as MeProfile);
    })();
  }, []);

  /*
   * The vault's shape is asked for as the window opens rather than when the
   * memory section is looked at, so it is usually here before it is wanted.
   */
  useEffect(() => {
    void loadGraph();
    return () => forgetGraph();
  }, []);

  return createPortal(
    <div className="scrim" onMouseDown={onClose}>
      <div
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <nav className="settings-nav" aria-label="Settings sections">
          <p className="settings-nav-head">Settings</p>
          {SECTIONS.map((name) => (
            <button
              key={name}
              className={`settings-tab${section === name ? ' is-current' : ''}`}
              aria-current={section === name}
              onClick={() => setSection(name)}
            >
              {name}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          <button className="settings-close" aria-label="Close settings" onClick={onClose}>
            ×
          </button>

          {section === 'General' && <General me={me} onChange={setMe} />}
          {section === 'Account' && <Account me={me} />}
          {section === 'Usage' && <Usage />}
          {section === 'Connections' && <Connections />}
          {section === 'Memory' && <Memory onConnect={() => setSection('Connections')} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function General({ me, onChange }: { me: MeProfile | null; onChange: (me: MeProfile) => void }) {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (me) setName(me.preferredName);
  }, [me]);

  if (!me) return <p className="muted">Loading…</p>;

  /**
   * Saved when they look away, not on every keystroke.
   *
   * A name is worth one request when they have finished typing it, not one
   * per letter -- and there is no Save button because a settings window with
   * one invites the question of what happens if you close without pressing it.
   */
  async function save(next: string) {
    if (!me || next.trim() === me.preferredName) return;
    await api.me.$patch({ json: { preferredName: next } });
    const res = await api.me.$get();
    if (res.ok) {
      onChange((await res.json()) as MeProfile);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    }
  }

  async function setAppearance(value: Appearance) {
    if (!me) return;
    // On screen first, then saved: a theme that waits for a round trip
    // feels like a switch that did not take.
    applyAppearance(value);
    onChange({ ...me, appearance: value });
    await api.me.$patch({ json: { appearance: value } });
  }

  return (
    <>
      <h2 className="settings-heading">Profile</h2>

      <Row label="Avatar">
        {/*
          The letter is the default and stands on its own. Hovering offers to
          replace it, which is the whole affordance -- a button beside it would
          be a second thing to explain.
        */}
        <button
          className="avatar-edit"
          aria-label="Change your picture"
          onClick={() => chooser.current?.click()}
        >
          <span className="account-initial">{initialOf(me.preferredName || me.name)}</span>
          <span className="avatar-overlay" aria-hidden="true">
            <CameraIcon />
          </span>
        </button>
        <input ref={chooser} type="file" accept="image/*" hidden onChange={() => {}} />
      </Row>

      <Row label="Full name">
        <span className="settings-static">{me.name}</span>
      </Row>

      <Row label="What should Contexto Agent call you?">
        <input
          className="settings-input"
          value={name}
          maxLength={60}
          placeholder={me.name.trim().split(/\s+/)[0] ?? ''}
          onChange={(event) => setName(event.target.value)}
          onBlur={(event) => void save(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        {saved && <span className="settings-saved">Saved</span>}
      </Row>

      <h2 className="settings-heading">Preferences</h2>

      <Row label="Appearance">
        <div className="segmented">
          {/* System follows the OS live; light and dark are pinned. */}
          {(['system', 'light', 'dark'] as const).map((option) => (
            <button
              key={option}
              className={me.appearance === option ? 'is-current' : ''}
              onClick={() => void setAppearance(option)}
            >
              {option === 'system' ? 'System' : option === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </Row>
    </>
  );
}

function Account({ me }: { me: MeProfile | null }) {
  const [signingOut, setSigningOut] = useState(false);

  return (
    <>
      <h2 className="settings-heading">Account</h2>

      <Row label="Signed in with Google">
        <span className="settings-static">{me?.email}</span>
      </Row>

      <DeviceConnections />

      {/*
       * Last, and under its own heading. The one control in here that ends
       * the session should not sit above the things a student came to see.
       */}
      <h2 className="settings-heading">Sign out</h2>

      <Row
        label="Log out of all devices"
        hint="Ends every session, including this one and any linked computer."
      >
        <button
          className="danger"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void signOut();
          }}
        >
          {signingOut ? 'Logging out…' : 'Log out'}
        </button>
      </Row>
    </>
  );
}

function Usage() {
  const [usage, setUsage] = useState<UsageStatus | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await api.usage.$get();
      if (res.ok) setUsage(await res.json());
    })();
  }, []);

  if (!usage) return <p className="muted">Loading…</p>;

  return (
    <>
      <h2 className="settings-heading">Usage</h2>
      <UsageBars usage={usage} />
    </>
  );
}

function Connections() {
  return (
    <>
      <GoogleConnections />
      {/* Another thing the agent can see, and the only one a browser cannot
          set up for itself. */}
      <SiteConnections />
    </>
  );
}

function Memory({ onConnect }: { onConnect: () => void }) {
  return (
    <>
      <h2 className="settings-heading">Your vault</h2>
      <p className="settings-intro">Built from your Classroom, Drive and Gmail.</p>
      {/*
       * The vault belongs to the student, not to a chat -- an account with no
       * chats still has one, so nothing here is gated on having one.
       */}
      <VaultMap onConnect={onConnect} />

      <ArchivedChats />
    </>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M3 6.5h3l1.2-2h5.6l1.2 2h3v9H3zM10 13.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
