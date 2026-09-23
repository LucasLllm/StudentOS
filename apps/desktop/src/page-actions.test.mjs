// @vitest-environment happy-dom
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActionError,
  GOOGLE_BUTTON,
  KEYS,
  SNAPSHOT_SCRIPT,
  keyNamed,
  performAction,
  settle,
  withElement,
} from './page-actions.mjs';

/**
 * The page is read as a numbered list and acted on by number. What these
 * pin down: that the list holds what a person could use and nothing they
 * should not see; that an action reaches the element it named, by the mouse
 * and the keyboard rather than a shortcut; and that the two refusals -- no
 * typing into a password box, no reporting what one holds -- are enforced
 * whatever the page says.
 */

/** A page in the test DOM, with every element given a size so it counts as visible. */
function page(html) {
  document.body.innerHTML = html;
  Element.prototype.getBoundingClientRect = () => ({
    width: 10,
    height: 10,
    left: 0,
    top: 0,
    right: 10,
    bottom: 10,
  });
}

// Indirect, so the script sees the page's globals and not this module's.
const read = () => JSON.parse((0, eval)(SNAPSHOT_SCRIPT));

describe('reading the page', () => {
  it('numbers what a person could use, and stamps the number on it', () => {
    page(`
      <p>Just words</p>
      <a href="/grades">Grades</a>
      <button>Search</button>
      <input placeholder="Find a course">
    `);
    const { elements } = read();
    expect(elements.map((e) => [e.ref, e.role, e.name])).toEqual([
      [1, 'link', 'Grades'],
      [2, 'button', 'Search'],
      [3, 'textbox', 'Find a course'],
    ]);
    expect(document.querySelector('[data-contexto-ref="2"]')?.textContent).toBe('Search');
    expect(elements[0].href).toMatch(/\/grades$/);
  });

  it('never reports what a password box holds', () => {
    page(`<input type="password" value="hunter2" aria-label="Password">`);
    const [box] = read().elements;
    expect(box.role).toBe('password');
    expect(box).not.toHaveProperty('value');
    expect(JSON.stringify(read())).not.toContain('hunter2');
  });

  it('reports the value of an ordinary box, and the choices in a list', () => {
    page(`
      <input aria-label="Search" value="chem">
      <select aria-label="Term"><option>Fall</option><option selected>Spring</option></select>
      <input type="checkbox" aria-label="Remember me" checked>
    `);
    const [box, list, tick] = read().elements;
    expect(box.value).toBe('chem');
    expect(list.options).toEqual(['Fall', 'Spring']);
    expect(list.value).toBe('Spring');
    expect(tick.checked).toBe(true);
  });

  it('leaves out what cannot be seen', () => {
    page(`
      <input type="hidden" name="token" value="x">
      <div hidden><button>Secret</button></div>
      <button>Shown</button>
    `);
    expect(read().elements.map((e) => e.name)).toEqual(['Shown']);
  });

  it('reads the same page twice without the numbers drifting', () => {
    page(`<button>A</button><button>B</button>`);
    read();
    document.body.insertAdjacentHTML('afterbegin', '<button>New</button>');
    expect(read().elements.map((e) => [e.ref, e.name])).toEqual([
      [1, 'New'],
      [2, 'A'],
      [3, 'B'],
    ]);
    expect(document.querySelectorAll('[data-contexto-ref]').length).toBe(3);
  });

  it('puts the number straight into the selector, so it must be a number', () => {
    expect(withElement(7, 'return 1;')).toContain('[data-contexto-ref="7"]');
    expect(withElement('7"] , body [x="', 'return 1;')).toContain('="NaN"');
  });
});

describe('the "Sign in with Google" button', () => {
  const press = () => JSON.parse((0, eval)(GOOGLE_BUTTON));

  it('presses the sign-in one, not any other mention of Google', () => {
    page(`<a href="#play">Get it on Google Play</a><button id="g">Continue with Google</button>`);
    Element.prototype.getClientRects = () => [{}];
    const pressed = vi.fn();
    document.getElementById('g').addEventListener('click', pressed);
    expect(press()).toEqual({ clicked: true });
    expect(pressed).toHaveBeenCalledOnce();
  });

  it('says so when there is none', () => {
    page(`<button>Sign in</button>`);
    Element.prototype.getClientRects = () => [{}];
    expect(press()).toEqual({ clicked: false });
  });
});

describe('keys', () => {
  it('finds a key however it is written', () => {
    expect(keyNamed('enter')?.name).toBe('Enter');
    expect(keyNamed('Return')?.name).toBe('Enter');
    expect(keyNamed('esc')?.name).toBe('Escape');
    expect(keyNamed('down')?.name).toBe('ArrowDown');
    expect(keyNamed('F13')).toBeNull();
  });

  it('gives Enter its character, so a form submits', () => {
    expect(KEYS.Enter.text).toBe('\r');
    expect(KEYS.Tab.text).toBeUndefined();
  });
});

const SNAP = JSON.stringify({
  url: 'https://x.test/',
  title: 'X',
  text: 'hello',
  elements: [{ ref: 1, role: 'button', name: 'Go' }],
});

/**
 * A session with a page that answers scripts as told, and records every
 * protocol command it is sent.
 */
function fakeSession(answer = () => '{}') {
  const sent = [];
  const webContents = Object.assign(new EventEmitter(), {
    isLoading: () => false,
    navigationHistory: { canGoBack: vi.fn(() => true), goBack: vi.fn() },
  });
  return {
    sent,
    webContents,
    cdp: {
      send: async (method, params = {}) => {
        sent.push({ method, ...params });
        return {};
      },
    },
    evaluate: vi.fn(async (script) => (script === SNAPSHOT_SCRIPT ? SNAP : answer(script))),
  };
}

/** Run an action through the waits it does, without actually waiting. */
async function act(session, action) {
  const done = performAction(session, action);
  // Awaited below. This only stops a refusal counting as unhandled while the
  // clock is being run forward.
  done.catch(() => {});
  await vi.runAllTimersAsync();
  return done;
}

describe('acting on the page', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A page whose element is on screen, and which heard the click as told. */
  const clickable = (heard) => (script) =>
    script.includes('getBoundingClientRect')
      ? JSON.stringify({ x: 40, y: 60, onScreen: true })
      : script.includes('__cxClick')
        ? JSON.stringify(heard)
        : JSON.stringify({ ok: true });

  it('clicks with the mouse, at the centre of the element it was told', async () => {
    const session = fakeSession(clickable({ landed: 'here' }));
    const after = await act(session, { action: 'click', ref: 3 });

    expect(session.evaluate.mock.calls[0][0]).toContain('[data-contexto-ref="3"]');
    expect(session.sent.map((s) => [s.type, s.x, s.y])).toEqual([
      ['mouseMoved', 40, 60],
      ['mousePressed', 40, 60],
      ['mouseReleased', 40, 60],
    ]);
    // Heard by the element, so nothing else is tried.
    expect(session.evaluate.mock.calls.map((c) => c[0]).some((s) => s.includes('el.click()'))).toBe(
      false,
    );
    // And reads the page after, so the agent can see what the click did.
    expect(after.elements[0].name).toBe('Go');
  });

  it('counts a click that took the page somewhere else as landed', async () => {
    const session = fakeSession(clickable({ gone: true }));
    await act(session, { action: 'click', ref: 3 });
    expect(session.evaluate.mock.calls.map((c) => c[0]).some((s) => s.includes('el.click()'))).toBe(
      false,
    );
  });

  it('falls back to the element itself when the browser dropped the press', async () => {
    const session = fakeSession(clickable({ landed: null }));
    await act(session, { action: 'click', ref: 3 });
    expect(session.sent.map((s) => s.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ]);
    expect(session.evaluate.mock.calls[2][0]).toContain('el.click()');
  });

  it('refuses when the press hit something in front of the element', async () => {
    const session = fakeSession(clickable({ landed: 'elsewhere' }));
    await expect(act(session, { action: 'click', ref: 3 })).rejects.toThrow(
      /behind something else/,
    );
    expect(session.evaluate.mock.calls.map((c) => c[0]).some((s) => s.includes('el.click()'))).toBe(
      false,
    );
  });

  it('falls back to the element itself when the mouse cannot reach it', async () => {
    const session = fakeSession((script) =>
      script.includes('getBoundingClientRect')
        ? JSON.stringify({ x: -5, y: -5, onScreen: false })
        : JSON.stringify({ ok: true }),
    );
    await act(session, { action: 'click', ref: 3 });
    expect(session.sent).toEqual([]);
    expect(session.evaluate.mock.calls[1][0]).toContain('el.click()');
  });

  it('says when the element has gone, and to look again', async () => {
    const session = fakeSession(() => JSON.stringify({ missing: true }));
    await expect(act(session, { action: 'click', ref: 3 })).rejects.toThrow(ActionError);
    await expect(act(session, { action: 'click', ref: 3 })).rejects.toThrow(/\[3\].*look/i);
  });

  it('types by the keyboard, and presses Enter only when told to submit', async () => {
    const session = fakeSession(() => JSON.stringify({ ok: true }));
    await act(session, { action: 'type', ref: 2, text: 'chemistry' });
    expect(session.sent).toEqual([{ method: 'Input.insertText', text: 'chemistry' }]);

    session.sent.length = 0;
    await act(session, { action: 'type', ref: 2, text: 'chemistry', submit: true });
    expect(session.sent.map((s) => [s.method, s.type ?? s.text])).toEqual([
      ['Input.insertText', 'chemistry'],
      ['Input.dispatchKeyEvent', 'keyDown'],
      ['Input.dispatchKeyEvent', 'keyUp'],
    ]);
    expect(session.sent[1].text).toBe('\r');
  });

  it('clears a box when told to type nothing', async () => {
    const session = fakeSession(() => JSON.stringify({ ok: true }));
    await act(session, { action: 'type', ref: 2, text: '' });
    expect(session.sent.map((s) => s.key)).toEqual(['Backspace', 'Backspace']);
  });

  it('never types what it was told into a password box', async () => {
    // No keychain to ask here, so the only honest answer is that nothing is
    // saved -- and the agent's own text goes nowhere either way.
    const session = fakeSession(() => JSON.stringify({ password: true }));
    await expect(act(session, { action: 'type', ref: 4, text: 'hunter2' })).rejects.toThrow(
      /no saved sign-in/i,
    );
    expect(session.sent).toEqual([]);
    expect(JSON.stringify(session.evaluate.mock.calls)).not.toContain('hunter2');
  });

  it('lists the choices when the one asked for is not there', async () => {
    const session = fakeSession(() =>
      JSON.stringify({ noMatch: true, options: ['Fall', 'Spring'] }),
    );
    await expect(act(session, { action: 'select', ref: 5, value: 'Summer' })).rejects.toThrow(
      /"Summer".*"Fall", "Spring"/,
    );
  });

  it('presses a key as a key, and refuses one it does not know', async () => {
    const session = fakeSession();
    await act(session, { action: 'press', key: 'Escape' });
    expect(session.sent.map((s) => [s.type, s.key])).toEqual([
      ['rawKeyDown', 'Escape'],
      ['keyUp', 'Escape'],
    ]);
    await expect(act(session, { action: 'press', key: 'F13' })).rejects.toThrow(/Enter/);
  });

  it('goes back only when there is somewhere to go', async () => {
    const session = fakeSession();
    await act(session, { action: 'back' });
    expect(session.webContents.navigationHistory.goBack).toHaveBeenCalled();

    session.webContents.navigationHistory.canGoBack.mockReturnValue(false);
    await expect(act(session, { action: 'back' })).rejects.toThrow(/no earlier page/);
  });

  it('scrolls the page a direction, or to an element, and needs one of them', async () => {
    const session = fakeSession(() => JSON.stringify({ ok: true }));
    await act(session, { action: 'scroll', direction: 'down' });
    expect(session.evaluate.mock.calls[0][0]).toContain('scrollBy');
    await act(session, { action: 'scroll', ref: 9 });
    expect(session.evaluate.mock.calls[2][0]).toContain('[data-contexto-ref="9"]');
    await expect(act(session, { action: 'scroll' })).rejects.toThrow(/direction/);
  });

  it('just looks, when asked to', async () => {
    const session = fakeSession();
    const after = await act(session, { action: 'look' });
    expect(after.title).toBe('X');
    expect(session.sent).toEqual([]);
    expect(session.evaluate).toHaveBeenCalledTimes(1);
  });

  it('needs a number for anything aimed at an element', async () => {
    const session = fakeSession();
    await expect(act(session, { action: 'click' })).rejects.toThrow(/number of an element/);
    await expect(act(session, { action: 'type', ref: 0, text: 'x' })).rejects.toThrow(ActionError);
    await expect(act(session, { action: 'dance' })).rejects.toThrow(/not something/);
  });
});

describe('settle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for a page that started loading to stop', async () => {
    let loading = true;
    const wc = Object.assign(new EventEmitter(), { isLoading: () => loading });
    let settled = false;
    const done = settle(wc, async () => {}).then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(250 + 800);
    expect(settled).toBe(false);

    loading = false;
    wc.emit('did-stop-loading');
    await vi.advanceTimersByTimeAsync(800);
    await done;
    expect(settled).toBe(true);
  });

  it('does not wait on a page that answered in place', async () => {
    const wc = Object.assign(new EventEmitter(), { isLoading: () => false });
    let settled = false;
    const done = settle(wc, async () => {}).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(250 + 800);
    await done;
    expect(settled).toBe(true);
  });
});

/**
 * Signing in, typed by this machine.
 *
 * The agent asks; the keychain answers, for the page's own origin and no
 * other; and what the agent itself typed never reaches a password box. The
 * page is a fake that reports an origin, accepts the fill, and hands back a
 * reading, so what is pinned here is the order and the boundary, not the DOM.
 */
describe('signing in', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const isFill = (script) => script.includes('no-sign-in-field');
  const isStepCheck = (script) => script.includes('second-factor');
  const isGoogleButton = (script) => script.includes('clicked');

  /**
   * A page that walks through the states it is given, one per fill, then rests
   * on 'none' (signed in). STEP_CHECK peeks the current state; the fill
   * consumes it. Each state carries the origin the page is on for that step.
   */
  const signInFlow = (steps, { google } = {}) => {
    let queue = [...steps];
    // A step with `lag` keeps showing itself for that many looks after it is
    // filled, the way Google's password page does while it checks.
    let lagging = null;
    return (script) => {
      if (lagging && (isStepCheck(script) || script.includes('location.origin'))) {
        const shown = isStepCheck(script)
          ? lagging.state
          : JSON.stringify({ origin: lagging.origin });
        if (isStepCheck(script) && --lagging.lag <= 0) lagging = null;
        return shown;
      }
      // The site's "Sign in with Google" button: pressing it swaps the rest of
      // the run for Google's pages.
      if (isGoogleButton(script)) {
        if (!google) return JSON.stringify({ clicked: false });
        queue = [...google];
        google = null;
        return JSON.stringify({ clicked: true });
      }
      if (isStepCheck(script)) return queue.length ? queue[0].state : 'none';
      if (script.includes('location.origin'))
        return JSON.stringify({ origin: queue.length ? queue[0].origin : 'https://studyo.app' });
      if (isFill(script)) {
        const filled = queue.shift();
        if (filled?.lag) lagging = { ...filled };
        return 'signed';
      }
      if (script.includes('data-contexto-ref')) return JSON.stringify({ password: true });
      return JSON.stringify({ ok: true });
    };
  };

  const pressedEnter = (session) =>
    session.sent.filter(
      (s) => s.method === 'Input.dispatchKeyEvent' && s.key === 'Enter' && s.type === 'keyDown',
    ).length;
  const fillsEvaluated = (session) => session.evaluate.mock.calls.map((c) => c[0]).filter(isFill);

  async function runAction(session, action, opts) {
    const done = performAction(session, action, opts);
    done.catch(() => {});
    await vi.runAllTimersAsync();
    return done;
  }

  it('signs in across every page it takes, filling each from the keychain', async () => {
    // The studyo -> Google shape: the site's own email, then Google's email,
    // then Google's password, then signed in.
    const session = fakeSession(
      signInFlow([
        { state: 'username', origin: 'https://accounts.studyo.app' },
        { state: 'username', origin: 'https://accounts.google.com' },
        { state: 'password', origin: 'https://accounts.google.com' },
      ]),
    );
    const asked = [];
    const credentialsFor = (origin) => {
      asked.push(origin);
      return { username: 'alice', password: 'hunter2' };
    };
    const after = await runAction(session, { action: 'sign_in' }, { credentialsFor });
    expect(asked).toEqual([
      'https://accounts.studyo.app',
      'https://accounts.google.com',
      'https://accounts.google.com',
    ]);
    expect(fillsEvaluated(session)).toHaveLength(3);
    expect(pressedEnter(session)).toBe(3);
    expect(after.title).toBe('X');
  });

  it('waits for a slow step to move on rather than calling it refused', async () => {
    // Measured on Kognity: Google's password page sat unchanged for a few
    // seconds after Enter while it checked, and the sign-in gave up on it.
    const session = fakeSession(
      signInFlow([
        { state: 'username', origin: 'https://accounts.google.com', lag: 4 },
        { state: 'password', origin: 'https://accounts.google.com' },
      ]),
    );
    await runAction(
      session,
      { action: 'sign_in' },
      { credentialsFor: () => ({ username: 'alice', password: 'hunter2' }) },
    );
    expect(fillsEvaluated(session)).toHaveLength(2);
  });

  it('stands back when a second factor only the student can answer appears', async () => {
    const session = fakeSession(
      signInFlow([
        { state: 'password', origin: 'https://accounts.google.com' },
        { state: 'second-factor', origin: 'https://accounts.google.com' },
      ]),
    );
    await runAction(
      session,
      { action: 'sign_in' },
      { credentialsFor: () => ({ username: 'alice', password: 'hunter2' }) },
    );
    // It filled the password once, then met the second factor and stopped --
    // it did not try to fill or submit that step.
    expect(fillsEvaluated(session)).toHaveLength(1);
    expect(pressedEnter(session)).toBe(1);
  });

  it('refuses, with somewhere to go, when nothing is saved for that origin', async () => {
    const session = fakeSession(signInFlow([{ state: 'username', origin: 'https://studyo.app' }]));
    await expect(
      runAction(session, { action: 'sign_in' }, { credentialsFor: () => null }),
    ).rejects.toThrow(/no saved sign-in/i);
    expect(fillsEvaluated(session)).toEqual([]);
  });

  it('goes through Google when nothing is saved and the site offers it', async () => {
    const session = fakeSession(
      signInFlow([{ state: 'username', origin: 'https://studyo.app' }], {
        google: [{ state: 'username', origin: 'https://accounts.google.com' }],
      }),
    );
    // Nothing saved for Google either, so it stops on Google's page and hands
    // that back rather than refusing.
    const after = await runAction(session, { action: 'sign_in' }, { credentialsFor: () => null });
    expect(after.title).toBe('X');
    expect(fillsEvaluated(session)).toEqual([]);
  });

  it('goes through Google when the site has no form of its own, with the saved sign-in', async () => {
    const session = fakeSession(
      signInFlow([], {
        google: [
          { state: 'username', origin: 'https://accounts.google.com' },
          { state: 'password', origin: 'https://accounts.google.com' },
        ],
      }),
    );
    await runAction(
      session,
      { action: 'sign_in' },
      { credentialsFor: () => ({ username: 'alice', password: 'hunter2' }) },
    );
    expect(fillsEvaluated(session)).toHaveLength(2);
  });

  it('tries Google when the site will not take the saved sign-in', async () => {
    const refused = { state: 'password', origin: 'https://studyo.app' };
    const flow = signInFlow([refused, refused], {
      google: [{ state: 'password', origin: 'https://accounts.google.com' }],
    });
    const session = fakeSession(flow);
    await runAction(
      session,
      { action: 'sign_in' },
      { credentialsFor: () => ({ username: 'alice', password: 'hunter2' }) },
    );
    // Once on the site, a second time that came back the same, then Google.
    const asked = session.evaluate.mock.calls.map((c) => c[0]);
    expect(asked.some(isGoogleButton)).toBe(true);
    expect(fillsEvaluated(session)).toHaveLength(2);
  });

  it('refuses when nobody can answer for the keychain at all', async () => {
    const session = fakeSession(signInFlow([{ state: 'username', origin: 'https://studyo.app' }]));
    await expect(runAction(session, { action: 'sign_in' })).rejects.toThrow(/no saved sign-in/i);
  });

  it('says so when the page is not asking for a sign-in', async () => {
    const session = fakeSession(signInFlow([]));
    await expect(
      runAction(
        session,
        { action: 'sign_in' },
        { credentialsFor: () => ({ username: 'alice', password: 'hunter2' }) },
      ),
    ).rejects.toThrow(/not asking for a sign-in/i);
  });

  it('types the saved sign-in, never the agent text, into a password box', async () => {
    const session = fakeSession(signInFlow([{ state: 'password', origin: 'https://studyo.app' }]));
    const credentialsFor = () => ({ username: 'alice', password: 'hunter2' });
    await runAction(
      session,
      { action: 'type', ref: 5, text: 'whatever the agent typed' },
      { credentialsFor },
    );
    const everything = JSON.stringify([session.evaluate.mock.calls, session.sent]);
    expect(everything).not.toContain('whatever the agent typed');
    expect(fillsEvaluated(session)).toHaveLength(1);
    expect(session.sent.some((s) => s.method === 'Input.insertText')).toBe(false);
  });
});
