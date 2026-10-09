/**
 * Doing things on a page the agent has open: clicking, typing, choosing.
 *
 * The page is handed to the agent as a list of numbered elements, and an
 * action names one by its number. The numbers are stamped onto the elements
 * themselves, as an attribute, when the page is read -- so the same number
 * finds the same element on the next call, for as long as the page has not
 * been rebuilt underneath it. When it has, the honest answer is that the
 * element is gone, and the agent looks again.
 *
 * The events are real. A click is a mouse press from the protocol at the
 * element's centre, and typed text arrives by the path a keyboard uses, so a
 * page that listens for pointer events, or a framework that owns its inputs,
 * sees what it would see from a person. The JavaScript shortcuts -- el.click(),
 * el.value = x -- are kept only as the fallback for an element the mouse
 * cannot reach.
 *
 * Two rules live here rather than in the prompt, so no page can talk the
 * agent out of them. The agent's own text never goes into a password field:
 * a password box takes only the sign-in this machine saved, read from the
 * keychain at that moment and only for the page's own site -- an agent that
 * could be made to type a password is an agent that could be made to type it
 * anywhere. And a password field's value is never reported, whatever it holds.
 */

import { signInScript } from './sign-in.mjs';
import { Failure, note } from './trace.mjs';

const ATTR = 'data-contexto-ref';
const MAX_ELEMENTS = 150;

/**
 * A reason the agent can act on, with its code. Written here, and the only kind
 * of message that travels back.
 */
export class ActionError extends Failure {
  constructor(code, message) {
    super(code, message);
    this.name = 'ActionError';
  }
}

/**
 * Read the page: where it is, what it says, and what on it can be used.
 *
 * Runs in the page. Every element a person could click, type into or choose
 * from gets a number, and the number is written onto the element so the
 * scripts below can find it again.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const ATTR = ${JSON.stringify(ATTR)};
  const MAX = ${MAX_ELEMENTS};
  for (const el of document.querySelectorAll('[' + ATTR + ']')) el.removeAttribute(ATTR);
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=checkbox]',
    '[role=radio]', '[role=switch]', '[role=option]', '[role=textbox]', '[role=combobox]',
    '[contenteditable=true]', '[contenteditable=""]', '[onclick]',
  ].join(',');
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const visible = (el) => {
    if (el.closest('[hidden],[aria-hidden=true]')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelText = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const ids = by.split(/\\s+/);
      const t = clean(ids.map((id) => (document.getElementById(id) || {}).innerText || '').join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = clean(Array.from(el.labels).map((l) => l.innerText).join(' '));
      if (t) return t;
    }
    return '';
  };
  const nameOf = (el) => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const label = labelText(el);
    if (label) return label;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const pressable = /^(submit|button|reset)$/.test(el.type || '');
      return clean(el.getAttribute('placeholder') || el.getAttribute('title') || (pressable ? el.value : '') || el.getAttribute('name'));
    }
    const own = clean(el.innerText || el.textContent);
    if (own) return own;
    const img = el.querySelector('img[alt]');
    if (img) return clean(img.getAttribute('alt'));
    return clean(el.getAttribute('title') || el.getAttribute('placeholder'));
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (/^(submit|button|reset|image)$/.test(type)) return 'button';
      if (/^(checkbox|radio|password|file)$/.test(type)) return type;
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  };
  const elements = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (elements.length >= MAX) break;
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    if (!visible(el)) continue;
    const role = roleOf(el);
    const entry = { ref: elements.length + 1, role, name: nameOf(el) };
    if (role === 'link') entry.href = el.href;
    // Not for a password: its value is never reported, whatever it holds.
    if (role === 'textbox' || role === 'select' || role === 'combobox') entry.value = clean(el.value);
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      entry.checked = Boolean(el.checked) || el.getAttribute('aria-checked') === 'true';
    }
    if (el.disabled) entry.disabled = true;
    if (role === 'select' && el.options) {
      entry.options = Array.from(el.options).slice(0, 30).map((o) => clean(o.textContent));
    }
    el.setAttribute(ATTR, String(entry.ref));
    elements.push(entry);
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText.slice(0, 20000) : '',
    elements,
  });
})()`;

/** A script that runs with `el` bound to the numbered element, or says it is missing. */
export function withElement(ref, body) {
  // The number was checked before it got here, so it can go straight into a selector.
  return `(() => {
    const el = document.querySelector('[${ATTR}="${Number(ref)}"]');
    if (!el) return JSON.stringify({ missing: true });
    ${body}
  })()`;
}

/*
 * Told where the click lands, and whether it landed at all.
 *
 * Measured: Chromium drops mouse presses -- not moves, presses -- for a
 * while after a page arrives, and in a view that is not on screen that while
 * has no end. A press that reached nothing looks exactly like one that
 * reached a button which did nothing, unless the page itself says which. So
 * the page is asked to listen before the press, and asked afterwards what it
 * heard: the element, something in front of it, or nothing.
 */
const CLICK_PREP = (ref, token) =>
  withElement(
    ref,
    `el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const token = ${JSON.stringify(token)};
    window.__cxClick = { token, landed: null };
    document.addEventListener(
      'click',
      (e) => {
        const mark = window.__cxClick;
        if (mark && mark.token === token && mark.landed === null) {
          mark.landed = el === e.target || el.contains(e.target) ? 'here' : 'elsewhere';
        }
      },
      { capture: true, once: true },
    );
    return JSON.stringify({
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      onScreen: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    });`,
  );

const CLICK_CHECK = (token) =>
  `JSON.stringify(window.__cxClick && window.__cxClick.token === ${JSON.stringify(token)} ? { landed: window.__cxClick.landed } : { gone: true })`;

const CLICK_FALLBACK = (ref) =>
  withElement(ref, `el.click(); return JSON.stringify({ ok: true });`);

const TYPE_PREP = (ref) =>
  withElement(
    ref,
    `const tag = el.tagName.toLowerCase();
    if (tag === 'input' && (el.type || '').toLowerCase() === 'password') return JSON.stringify({ password: true });
    if (!(tag === 'input' || tag === 'textarea' || el.isContentEditable)) return JSON.stringify({ notEditable: true });
    if (el.disabled || el.readOnly) return JSON.stringify({ readOnly: true });
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
    if (tag === 'input' || tag === 'textarea') {
      // Selected so the typing replaces it. A box that cannot select -- a
      // date, a colour -- is emptied through the setter a framework watches.
      try {
        el.select();
      } catch {
        const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, ''); else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return JSON.stringify({ ok: true });`,
  );

const SELECT_OPTION = (ref, value) =>
  withElement(
    ref,
    `if (el.tagName.toLowerCase() !== 'select') return JSON.stringify({ notSelect: true });
    const wanted = ${JSON.stringify(value)}.trim().toLowerCase();
    const options = Array.from(el.options);
    const text = (o) => (o.textContent || '').trim();
    const match =
      options.find((o) => o.value.trim().toLowerCase() === wanted) ||
      options.find((o) => text(o).toLowerCase() === wanted) ||
      options.find((o) => text(o).toLowerCase().includes(wanted));
    if (!match) return JSON.stringify({ noMatch: true, options: options.slice(0, 30).map(text) });
    // Through the prototype setter and with the events, so a framework that
    // owns the control sees the change rather than its own stale state.
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (setter && setter.set) setter.set.call(el, match.value); else el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ ok: true, chosen: text(match) });`,
  );

const SCROLL_TO = (ref) =>
  withElement(
    ref,
    `el.scrollIntoView({ block: 'center', inline: 'center' }); return JSON.stringify({ ok: true });`,
  );

const DIRECTIONS = ['down', 'up', 'top', 'bottom'];

const SCROLL_PAGE = (direction) => `(() => {
  const page = document.scrollingElement || document.documentElement;
  const step = innerHeight * 0.8;
  const moves = {
    down: () => scrollBy(0, step),
    up: () => scrollBy(0, -step),
    top: () => scrollTo(0, 0),
    bottom: () => scrollTo(0, page.scrollHeight),
  };
  moves[${JSON.stringify(direction)}]();
  return JSON.stringify({ ok: true });
})()`;

/**
 * The keys the agent can press, as the protocol wants them described.
 *
 * Enter and Space carry text because that is what makes a form submit or a
 * button fire; the rest are navigation and editing keys with no character.
 */
export const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

const ALIASES = {
  return: 'Enter',
  esc: 'Escape',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  del: 'Delete',
};

/** The key a name refers to, however it was capitalised, or null. */
export function keyNamed(name) {
  const wanted = String(name ?? '').trim();
  const canonical =
    Object.keys(KEYS).find((k) => k.toLowerCase() === wanted.toLowerCase()) ??
    ALIASES[wanted.toLowerCase()];
  return canonical ? { name: canonical, ...KEYS[canonical] } : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Do something, then wait for the page to catch up with it.
 *
 * A click that leaves the page has started leaving within a moment, and then
 * the load is waited for the way a navigation is. A page that answers in place,
 * with a request of its own, gets a moment to draw the answer before it is
 * read. Neither wait is exact; both are what a person does before looking.
 */
export async function settle(wc, act, { timeoutMs = 30_000, quietMs = 800 } = {}) {
  await act();
  await sleep(250);
  if (!(await loaded(wc, timeoutMs))) {
    // Read anyway: a page still fetching its last advert is usually usable.
    note('settle.still_loading', { afterMs: timeoutMs, url: wc.getURL?.() ?? null });
  }
  await sleep(quietMs);
}

function loaded(wc, timeoutMs) {
  if (!wc.isLoading()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      wc.off('did-stop-loading', done);
      resolve(false);
    }, timeoutMs);
    wc.once('did-stop-loading', done);
  });
}

async function run(session, script) {
  const raw = await session.evaluate(script);
  return typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
}

function gone(ref) {
  return new ActionError(
    'page.element_gone',
    `There is no element [${ref}] on the page any more -- it has changed since it was read. ` +
      'Look at the page again and use a number from the new list.',
  );
}

let clicks = 0;

/*
 * Make the page draw before it is pressed.
 *
 * Measured on a parked view: after a page moves to a new renderer -- Kognity
 * handing off to Google -- every press was dropped, for as long as anyone
 * waited, until the view was captured once. A capture takes a couple of
 * milliseconds and returns nothing useful here; what matters is that it
 * makes the new page draw, and a page that has drawn takes presses.
 */
async function drawn(session) {
  const wc = session.webContents;
  if (!wc?.capturePage) return;
  await Promise.race([
    wc.capturePage().catch((error) => note('click.draw_failed', { error: error.message })),
    sleep(1000),
  ]);
}

/**
 * Press an element, and say whether the press landed on it.
 *
 * With `fallback: false` a dropped press is reported rather than followed by a
 * script click -- for a caller with a better second way, since some pages
 * (Google's sign-in) ignore a script click altogether.
 */
async function click(session, ref, { fallback = true } = {}) {
  const token = `click-${++clicks}`;
  const at = await run(session, CLICK_PREP(ref, token));
  if (at.missing) throw gone(ref);

  if (at.onScreen) {
    await drawn(session);
    const point = { x: at.x, y: at.y };
    const press = { ...point, button: 'left', clickCount: 1 };
    await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...press });
    await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...press });
    await sleep(150);

    let heard;
    try {
      heard = await run(session, CLICK_CHECK(token));
    } catch (error) {
      // The page went somewhere while being asked. The click took it there.
      note('click.page_left', { ref, error: String(error?.message ?? error) });
      return true;
    }
    if (heard.gone || heard.landed === 'here') return true;
    if (heard.landed === 'elsewhere') {
      throw new ActionError(
        'page.element_covered',
        `[${ref}] is behind something else on the page, so the click did not reach it. Close ` +
          'or dismiss whatever is in front of it first -- it is in the list too.',
      );
    }
  }

  if (!fallback) return false;
  // Off the edge of a view that has no size yet, or a press the browser
  // dropped. The element is still there; its own click handler gets it.
  await run(session, CLICK_FALLBACK(ref));
  return true;
}

export async function pressKey(cdp, name) {
  const key = keyNamed(name);
  if (!key) {
    throw new ActionError(
      'page.bad_key',
      `"${name}" is not a key this can press. It can press: ${Object.keys(KEYS).join(', ')}.`,
    );
  }
  const base = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    nativeVirtualKeyCode: key.keyCode,
  };
  await cdp.send('Input.dispatchKeyEvent', {
    type: key.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Where the page is from, so a saved sign-in only ever reaches its own site. */
const ORIGIN = `JSON.stringify({ origin: location.origin })`;

/**
 * What the page is asking for right now, without touching it.
 *
 * 'password' or 'username' when a visible box of that kind is on the page,
 * 'second-factor' when it is past the password and wants something only the
 * student has, and 'none' when it is asking for no sign-in at all -- signed
 * in, or somewhere else entirely. Read before each step so the sign-in knows
 * whether it is done, whether to fill, and when to stand back.
 */
const STEP_CHECK = `(() => {
  const shown = (el) => {
    if (!el || el.disabled) return false;
    const s = el.style;
    if (s && (s.display === 'none' || s.visibility === 'hidden')) return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };
  const text = (document.body && document.body.innerText) || '';
  if (/\\b(2-step|two-step|2-factor|verify it.s you|verify your identity|passkey|authenticator|enter the code|verification code|tap yes|check your (phone|device)|approve this sign)\\b/i.test(text))
    return 'second-factor';
  const pw = Array.from(document.querySelectorAll('input[type=password]')).find(shown);
  if (pw) return 'password';
  const user = Array.from(document.querySelectorAll('input')).find(
    (i) => /^(text|email|tel)$/.test(i.type) && shown(i),
  );
  if (user) return 'username';
  return 'none';
})()`;

/**
 * Press the site's own "Sign in with Google" button, if it has one.
 *
 * The way in for a site that is behind Google, and the fallback for one whose
 * own form would not take the saved sign-in. Never on Google's own pages,
 * where the word is everywhere and no button of it leads anywhere new.
 */
export const GOOGLE_BUTTON = `(() => {
  if (location.hostname === 'accounts.google.com') return JSON.stringify({ clicked: false });
  const shown = (el) => {
    if (!el || el.disabled) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };
  const said = (el) =>
    [el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('title'),
      ...Array.from(el.querySelectorAll('img')).map((i) => i.alt)].join(' ');
  // A way in with Google, not anything else of Google's: "Connect Google
  // Drive" or "Get it on Google Play" on a page is never pressed.
  const signIn = (t) =>
    /google/i.test(t) &&
    !/\\b(drive|classroom|play|calendar|docs|sheets|slides|forms|maps|meet|photos|store|workspace)\\b/i.test(t) &&
    /(sign|log)\\s*(in|on|up)|continue|(with|use|using|via)\\s+google|^\\s*google\\s*$/i.test(t);
  const button = Array.from(
    document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button]'),
  ).find((el) => shown(el) && signIn(said(el)));
  if (!button) return JSON.stringify({ clicked: false });
  button.click();
  return JSON.stringify({ clicked: true });
})()`;

/** The number a sign-in step's submit button is marked with, beyond any the page gets. */
const SUBMIT_REF = MAX_ELEMENTS + 1;

/**
 * Mark the sign-in step's own submit button -- Next, Continue, Sign in -- so
 * it can be pressed like any numbered element.
 *
 * By its words first, so "Forgot email?" and "Create account" beside it are
 * never it; then a form's submit button. Says whether there was one: without
 * it, Enter is the way to submit the step.
 */
export const SUBMIT_BUTTON = `(() => {
  const shown = (el) => {
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };
  const words = (el) => String(el.innerText || el.value || el.getAttribute('aria-label') || '')
    .replace(/\\s+/g, ' ').trim();
  const buttons = Array.from(
    document.querySelectorAll('button, input[type=submit], [role=button]'),
  ).filter(shown);
  const field = document.activeElement;
  const button =
    buttons.find((el) => /^(next|continue|sign ?in|log ?in|submit|verify|suivant|continuer|se connecter|connexion)$/i.test(words(el))) ||
    (field && field.form
      ? buttons.find((el) => el.form === field.form && (el.type || '').toLowerCase() === 'submit')
      : null);
  for (const el of document.querySelectorAll('[${ATTR}="${SUBMIT_REF}"]')) el.removeAttribute('${ATTR}');
  if (!button) return JSON.stringify({ submitButton: false });
  button.setAttribute('${ATTR}', '${SUBMIT_REF}');
  return JSON.stringify({ submitButton: true });
})()`;

/**
 * Submit the step just filled: a press on its own button, or Enter.
 *
 * The press, as a person would, because Google's Next ignores a script's
 * submit and a script click, and a key reaches it only when the window has
 * the keyboard. Only a press that lands counts. Measured on Google: its Next
 * can be a moment behind its field, and on the password page something sits
 * over it for a moment as the page arrives -- so a missing, covered or
 * dropped press is tried again a second later. Enter is the last resort, for
 * a step with no button of its own, where a form submits on it.
 */
async function submitStep(session) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(1000);
    const { submitButton } = await run(session, SUBMIT_BUTTON);
    if (!submitButton) continue;
    try {
      if (await click(session, SUBMIT_REF, { fallback: false })) {
        note('sign_in.submitted', { by: 'button', attempt });
        return;
      }
      note('sign_in.submit_dropped', { attempt });
    } catch (error) {
      // Something in front of it, for now.
      note('sign_in.submit_covered', { attempt, error: String(error?.message ?? error) });
    }
  }
  note('sign_in.submitted', { by: 'enter' });
  await pressKey(session.cdp, 'Enter');
}

/** How long one sign_in may take, inside the 75 seconds the agent waits for it. */
const SIGN_IN_BUDGET_MS = 55_000;

/**
 * Sign in with what this machine saved, across as many pages as it takes.
 *
 * A sign-in is rarely one page: a site asks for an email, then a password; a
 * site that signs in through Google hands off to a Google page that asks the
 * same, one field at a time. So this drives the whole run rather than one
 * field -- read what the page wants, fill it from the keychain for that page's
 * own site, submit it, wait, and look again -- until it is in, or a
 * second factor only the student can answer stops it. The keychain is asked
 * per page, so it answers for the site's own pages and that site's Google
 * step and nowhere else; the answer goes into the page and never to the agent.
 *
 * Google is the other way in. With nothing saved, a site with no form of its
 * own, or a saved sign-in the site will not take, it presses the site's
 * "Sign in with Google" once and carries on from Google's page -- where the
 * browser may already be signed in, or the saved sign-in fills Google's step.
 */
async function signInFromKeychain(session, credentialsFor) {
  const wc = session.webContents;
  const seen = new Set();
  let triedGoogle = false;
  const throughGoogle = async () => {
    if (triedGoogle) return false;
    triedGoogle = true;
    const { clicked } = await run(session, GOOGLE_BUTTON);
    note('sign_in.google_button', { clicked });
    if (!clicked) return false;
    await settle(wc, async () => {}, { quietMs: 1000 });
    await new Promise((r) => setTimeout(r, 800));
    return true;
  };
  /*
   * The agent waits 75 seconds for the answer and then tells the student their
   * computer is asleep, so the page goes back well inside that: a run cut off
   * here is picked up by the next sign_in, from wherever it got to.
   */
  const deadline = Date.now() + SIGN_IN_BUDGET_MS;
  for (let step = 0; step < 6 && Date.now() < deadline; step += 1) {
    const { state, origin } = await whereSignInIs(session);
    note('sign_in.step', { step, state, origin });

    // The student finishes this one step; it is theirs, not a failure.
    if (state === 'second-factor') return { status: 'second_factor', steps: step, origin };

    if (state === 'none') {
      if (step === 0) {
        if (await throughGoogle()) continue;
        throw new ActionError(
          'page.not_signin_page',
          'This page is not asking for a sign-in. Look again.',
        );
      }
      /*
       * Checked, not assumed. No sign-in box on the site itself is signed in;
       * no sign-in box on Google's own pages is a Google step this does not
       * know -- choosing an account, a consent screen -- and calling that
       * signed in is how the agent came to tell students it had worked.
       */
      if (isGoogleOrigin(origin)) {
        throw new Failure(
          'signin.stuck',
          'The sign-in stopped on a Google page that asks for something other than a username or password -- probably choosing an account or allowing access. Ask the student to finish it in the browser card, then look again.',
          { state, origin, step },
        );
      }
      return { status: 'signed_in', steps: step, origin };
    }

    const saved = origin ? await credentialsFor?.(origin) : null;
    if (!saved) {
      if (await throughGoogle()) continue;
      note('sign_in.no_credentials_for', { origin, step });
      throw new ActionError(
        'signin.no_credentials',
        (step === 0
          ? 'There is no saved sign-in for this site and no "Sign in with Google" button to press. '
          : `The sign-in reached ${hostOf(origin)}, and there is no saved sign-in that belongs there. `) +
          'Tell the student they can sign in once in the browser card in this conversation and ' +
          'it stays signed in, or save a sign-in under Settings, Connections, Sites.',
      );
    }
    // A page that comes back the same after a fill did not advance -- a refused
    // sign-in, or a step this cannot work -- so try Google, or stop rather than
    // spin on it.
    const mark = `${origin}|${state}`;
    if (seen.has(mark)) {
      if (await throughGoogle()) continue;
      const pageSaid = await run(session, ERROR_TEXT).catch((error) => {
        note('sign_in.error_text_unreadable', { error: error.message });
        return {};
      });
      throw new Failure(
        'signin.rejected',
        `${hostOf(origin)} did not accept the saved sign-in: its ${state} step came back ` +
          'unchanged after it was filled and submitted.' +
          (pageSaid.text ? ' The page showed an error message.' : ''),
        { state, origin, step, pageSaid: pageSaid.text ?? null },
      );
    }
    seen.add(mark);
    const filled = await session.evaluate(signInScript(saved.username, saved.password));
    note('sign_in.filled', { step, result: filled });
    if (filled === 'no-sign-in-field') {
      throw new Failure('signin.stuck', undefined, { state, origin, step, filled });
    }
    // Submitted by a real press, not by the page: Google's Next ignores a
    // script's submit.
    await submitStep(session);
    await settle(wc, async () => {}, { quietMs: 1000 });
    await movedOn(session, origin, state, deadline);
  }
  /*
   * One last look before calling it a failure: the fill that used the last
   * step, or the last seconds, may have been the one that worked.
   */
  const final = await whereSignInIs(session);
  note('sign_in.final_look', final);
  if (final.state === 'none' && !isGoogleOrigin(final.origin)) {
    return { status: 'signed_in', steps: 6, origin: final.origin };
  }
  if (final.state === 'second-factor') {
    return { status: 'second_factor', steps: 6, origin: final.origin };
  }
  const last = final;
  if (Date.now() >= deadline) {
    throw new Failure(
      'signin.timeout',
      `The sign-in ran out of time on ${hostOf(last.origin)} (${last.state} step). ` +
        'Calling sign_in again carries on from there.',
      last,
    );
  }
  throw new Failure(
    'signin.stuck',
    `The sign-in went through six steps and ${hostOf(last.origin)} was still asking ` +
      `(${last.state} step).`,
    last,
  );
}

/**
 * What the sign-in page is asking for, and where it is.
 *
 * Asked again, briefly, when the page is between documents: a check that lands
 * mid-navigation fails with the old page's context gone, which is the page
 * moving on -- not a reason to abandon the sign-in.
 */
async function whereSignInIs(session) {
  for (let tries = 1; ; tries += 1) {
    try {
      const state = await session.evaluate(STEP_CHECK);
      const { origin } = await run(session, ORIGIN);
      return { state, origin };
    } catch (error) {
      if (tries >= 4) throw error;
      note('sign_in.page_between', { tries, error: String(error?.message ?? error) });
      await sleep(750);
    }
  }
}

function isGoogleOrigin(origin) {
  return origin === 'https://accounts.google.com';
}

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    // expected: no origin was read; say so in words instead.
    return 'the sign-in page';
  }
}

/**
 * The words of an error message near a sign-in form, for the trace only.
 * They are the page's, so they never travel to the agent.
 */
const ERROR_TEXT = `(() => {
  const el = Array.from(document.querySelectorAll(
    '[role=alert], [aria-live=assertive], [aria-live=polite], .error, .alert-danger, [class*="error" i]'
  )).find((e) => (e.innerText || '').trim());
  return JSON.stringify({ text: el ? el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) : null });
})()`;

/**
 * Wait, up to ten seconds, for the page to leave the step just submitted.
 *
 * Google draws its next step after the load settles, and checking a password
 * takes it a few seconds. Measured on Kognity: looking again at 1.8s found the
 * password page still there, the sign-in called it refused and stopped, and
 * Google signed in a moment later behind it. A page that has not moved after
 * this long really did come back the same.
 */
async function movedOn(session, origin, state, deadline) {
  for (let waited = 0; waited < 10_000 && Date.now() < deadline; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await session.evaluate(STEP_CHECK)) !== state) return;
      if ((await run(session, ORIGIN)).origin !== origin) return;
    } catch (error) {
      // Asked mid-navigation: it is moving.
      note('sign_in.moving', { error: String(error?.message ?? error) });
      return;
    }
  }
}

async function type(session, ref, text, submit, credentialsFor) {
  const box = await run(session, TYPE_PREP(ref));
  if (box.missing) throw gone(ref);
  if (box.password) {
    // The agent's text is dropped here, whatever it was. A password box takes
    // only the sign-in saved for this site, typed by this machine -- and how
    // that went is handed back like any sign_in.
    return { signIn: await signInFromKeychain(session, credentialsFor) };
  }
  if (box.notEditable) {
    throw new ActionError('page.not_editable', `[${ref}] is not something that can be typed into.`);
  }
  if (box.readOnly) {
    throw new ActionError('page.read_only', `[${ref}] does not accept typing right now.`);
  }
  if (text) await session.cdp.send('Input.insertText', { text });
  else await pressKey(session.cdp, 'Backspace');
  if (submit) await pressKey(session.cdp, 'Enter');
}

async function select(session, ref, value) {
  const chosen = await run(session, SELECT_OPTION(ref, value));
  if (chosen.missing) throw gone(ref);
  if (chosen.notSelect)
    throw new ActionError('page.not_select', `[${ref}] is not a drop-down list.`);
  if (chosen.noMatch) {
    /*
     * The options' words are the page's, and only words this app wrote travel
     * back as a reason. They are in the page reading, under the warning that
     * goes with page text; the reason only points there.
     */
    const count = (chosen.options ?? []).length;
    note('select.no_match', { ref, offered: count });
    throw new ActionError(
      'page.no_option',
      `[${ref}] has no option matching "${value}". It has ${count} options -- look at the ` +
        'page again and choose one of them by its text.',
    );
  }
}

async function scroll(session, ref, direction) {
  if (ref) {
    const at = await run(session, SCROLL_TO(ref));
    if (at.missing) throw gone(ref);
    return;
  }
  if (!DIRECTIONS.includes(direction)) {
    throw new ActionError(
      'page.bad_scroll',
      `Scroll needs a direction (${DIRECTIONS.join(', ')}) or an element.`,
    );
  }
  await run(session, SCROLL_PAGE(direction));
}

function back(wc) {
  const history = wc.navigationHistory ?? wc;
  if (!history.canGoBack()) {
    throw new ActionError('page.no_history', 'There is no earlier page to go back to.');
  }
  history.goBack();
}

/** The page as the agent should see it now. */
export async function snapshot(session) {
  return run(session, SNAPSHOT_SCRIPT);
}

function refOf(action) {
  const ref = action?.ref;
  return Number.isInteger(ref) && ref > 0 ? ref : null;
}

/**
 * Carry out one action on the page this session holds, and read the page after.
 *
 * Every action ends in a fresh reading, because whatever it did is only
 * useful to an agent that can now see the result.
 */
export async function performAction(session, action, { credentialsFor } = {}) {
  const wc = session.webContents;
  const kind = action?.action;
  const ref = refOf(action);
  const needsRef = () => {
    if (!ref) {
      throw new ActionError(
        'page.needs_ref',
        `${kind} needs the number of an element from the page.`,
      );
    }
  };

  switch (kind) {
    case 'look':
      break;
    case 'click':
      needsRef();
      await settle(wc, () => click(session, ref));
      break;
    case 'type':
      needsRef();
      if (typeof action.text !== 'string') {
        throw new ActionError('page.needs_text', 'type needs the text to type.');
      }
      {
        let typed;
        await settle(wc, async () => {
          typed = await type(session, ref, action.text, Boolean(action.submit), credentialsFor);
        });
        if (typed?.signIn) return { ...(await snapshot(session)), signIn: typed.signIn };
      }
      break;
    case 'sign_in': {
      // Drives its own pages and waits between them, so it is not wrapped here.
      const signIn = await signInFromKeychain(session, credentialsFor);
      return { ...(await snapshot(session)), signIn };
    }
    case 'press':
      await settle(wc, () => pressKey(session.cdp, action.key));
      break;
    case 'select':
      needsRef();
      if (typeof action.value !== 'string') {
        throw new ActionError('page.needs_text', 'select needs the option to choose.');
      }
      await settle(wc, () => select(session, ref, action.value));
      break;
    case 'scroll':
      await settle(wc, () => scroll(session, ref, action.direction), { quietMs: 400 });
      break;
    case 'back':
      await settle(wc, () => back(wc));
      break;
    default:
      throw new ActionError(
        'page.unknown_action',
        `"${kind}" is not something this browser can do.`,
      );
  }
  return snapshot(session);
}
