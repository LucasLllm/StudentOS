import { useEffect, useState } from 'react';
import { api } from './lib/api.js';
import { desktop } from './lib/desktop.js';
import { MAC_DOWNLOAD } from './lib/download.js';
import { navigate, useRoute } from './lib/router.js';
import { signInWithGoogle, useSession } from './lib/auth.js';
import { applyAppearance, useResolvedTheme, type Appearance } from './lib/theme.js';
import { Chat } from './screens/Chat.js';
import { NewChat } from './screens/NewChat.js';
import { Projects } from './screens/Projects.js';
import { Sidebar } from './screens/Sidebar.js';
import { LinkDevice } from './screens/LinkDevice.js';
import { Settings } from './screens/Settings.js';

export function App() {
  const { data: session, isPending } = useSession();
  const theme = useResolvedTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // View state lives in the URL now, so refresh and Back both behave.
  const route = useRoute();
  /*
   * What the student has asked to be called, when they have asked.
   *
   * Loaded here rather than in the greeting, because the rail's footer wants
   * it too and one request is enough. Undefined until it arrives, which the
   * greeting reads as "no name yet" and simply leaves those lines out.
   */
  const [preferred, setPreferred] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!session?.user) return;
    void (async () => {
      const res = await api.me.$get();
      if (!res.ok) return;
      const me = (await res.json()) as { preferredName: string; appearance: Appearance };
      setPreferred(me.preferredName);
      // The account's choice wins over whatever this browser last remembered.
      applyAppearance(me.appearance);
    })();
  }, [session?.user]);

  /*
   * Report the browser's timezone once signed in.
   *
   * The server cannot infer this reliably, and without it the agent asks what
   * timezone you are in every time you mention "tomorrow". Fire-and-forget:
   * a failure here should never block the app.
   */
  useEffect(() => {
    if (!session?.user) return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) return;
    void api.me.timezone.$put({ json: { timezone } }).catch(() => {});
  }, [session?.user]);

  if (isPending) {
    return (
      <main>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (!session?.user) {
    return (
      <main>
        <div className="signin">
          <img src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'} alt="Contexto Agent" />
          {/*
            This screen is what an unauthenticated visitor sees at the root, so
            it is the app's home page in Google's sense as well as the product's
            -- and brand verification asks a home page to describe what the app
            does and to link its privacy policy and terms. A lone sign-in button
            satisfies neither, and that is a routine rejection.
          */}
          <p className="muted">
            An AI agent that knows your coursework. Connect Google Classroom, Drive and Gmail, and
            it can tell you what is due, find the material a teacher posted, and work through the
            files you have written.
          </p>
          <div className="panel">
            <p>Sign in with your educational Google account to get started.</p>
            {/*
              Inside the desktop app, signing in does not go through Google
              here. A linked computer can exchange its link for a session --
              the same question already answered when it was linked -- and if
              that fails the app opens the student's own browser, where they
              are already signed in and can see the address bar.
            */}
            {desktop()?.signIn ? (
              <button
                className="primary"
                onClick={async () => {
                  const result = await desktop()?.signIn?.();
                  if (result && !result.ok) alert(result.error ?? 'Could not sign in.');
                }}
              >
                Continue with Google
              </button>
            ) : (
              <button className="primary" onClick={() => void signInWithGoogle()}>
                Continue with Google
              </button>
            )}
          </div>

          {/*
            Outside the panel and below it, deliberately. Signing in is what a
            new visitor needs first; the app is useless until there is an
            account to link it to. Hidden inside the desktop app, where
            offering the download would be offering them what they are using.
          */}
          {!desktop() && (
            <>
              <p className="muted download-label">Download Contexto Agent desktop app</p>
              <a className="button blue" href={MAC_DOWNLOAD}>
                Download for macOS
              </a>
            </>
          )}

          {/*
            Plain anchors, not client routes: these are static HTML files served
            straight off disk so they load without the bundle. See
            apps/web/public/privacy/.
          */}
          <p className="muted signin-legal">
            <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a>
          </p>
        </div>
      </main>
    );
  }

  return (
    <div className="app">
      <Sidebar
        route={route}
        name={preferred ?? session.user.name}
        email={session.user.email}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/*
        The scrim, and the only thing that closes the drawer by tapping away
        from it. Present at every width; it has no size until the drawer is
        a drawer.
      */}
      <div
        className="nav-scrim"
        onClick={() => document.body.classList.remove('nav-open')}
        aria-hidden="true"
      />

      {/*
        Centred for settings too: the new-chat screen stays mounted behind
        the window, and dropping the class dropped it into the corner.
      */}
      <main
        className={
          route.name === 'new' || route.name === 'settings' ? 'app-main is-new' : 'app-main'
        }
      >
        <button
          className="nav-toggle"
          aria-label="Chats"
          onClick={() => document.body.classList.toggle('nav-open')}
        >
          <span />
        </button>

        {/*
          Settings opens over whatever you were doing rather than replacing
          it, so the new-chat screen stays mounted behind the window.
        */}
        {(route.name === 'new' || route.name === 'settings') && (
          <NewChat name={preferred ?? session.user.name} />
        )}

        {route.name === 'chat' && (
          /*
           * Keyed, so moving between conversations builds a new one rather than
           * repainting the old.
           *
           * Without it React kept a single Chat and only swapped the prop, so
           * everything it was holding came along: a reply still in flight landed
           * in whichever conversation was open by the time it arrived, the
           * composer stayed disabled because some other chat was mid-turn, and a
           * half-typed message followed you into a different agent. A
           * conversation is not a repaint of another one.
           */
          <Chat key={route.agentId} agentId={route.agentId} />
        )}

        {route.name === 'projects' && <Projects />}

        {route.name === 'link' && <LinkDevice requestId={route.requestId} />}

        {route.name === 'notFound' && (
          <div className="panel">
            <p>There&apos;s nothing at this address.</p>
            <button onClick={() => navigate({ name: 'new' })}>Start a new chat</button>
          </div>
        )}
      </main>

      {/*
        A window over wherever you are, not a place you go: opened from the
        rail it changes nothing behind it, and closing it leaves you where
        you were. /settings still works as an address -- the link screen
        sends people there -- and then there is nothing behind it but the
        new-chat screen, so closing goes there.
      */}
      {(settingsOpen || route.name === 'settings') && (
        <Settings
          onClose={() => {
            setSettingsOpen(false);
            if (route.name === 'settings') navigate({ name: 'new' });
          }}
        />
      )}
    </div>
  );
}
