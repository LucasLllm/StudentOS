# School Profile Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent's in-app browser behave like one signed-in Chrome profile — one shared session, a user agent Google accepts, a sign-in the machine types from the keychain, and a screenshot of the page after every step.

**Architecture:** The agent's browser is an Electron `WebContentsView` driven over the DevTools protocol, on the student's own machine, per conversation. Today each connected site has its own persistent partition and non-site browsing uses a throwaway one; this collapses them to a single persistent partition so a Google sign-in carries across sites. A new `sign_in` browser action fills a login form from the keychain, keeping the password on the machine and letting Google be signed into once by hand. After each step the machine captures the view and streams a frame to the conversation card.

**Tech Stack:** Electron 39 (`WebContentsView`, `webContents.debugger`, `webContents.capturePage`), Node ESM (`.mjs`) on the desktop; React + TypeScript (`.tsx`) on the web; Zod tools in the agent package; Vitest with happy-dom throughout.

**Spec:** `docs/superpowers/specs/2026-09-21-school-profile-browser-design.md`

## Global Constraints

- **The agent never receives a password.** Credentials are read from the keychain on the student's computer, at the moment of typing, and go into the page and nowhere else. No credential value crosses the desktop↔server boundary or reaches the agent package.
- **A saved password only goes to the origin it was saved for.** Match the page's origin against a connected site's stored origin exactly — full origin, never a host suffix.
- **A password box never reports what it holds.** The snapshot already omits its value and `renderElements` drops it; both stay.
- **One implementation of form-filling.** The browser the student watches and every other path fill a sign-in the same way, through the helpers in `sign-in.mjs`; do not add a second filler.
- **Desktop is ESM `.mjs`, no TypeScript.** Match the surrounding file's style and comment voice.
- **Tests run with** `pnpm test` (root `vitest run`). Web and desktop DOM tests use `// @vitest-environment happy-dom`.
- **Existing security tests must keep passing:** `apps/desktop/src/page-actions.test.mjs` ("never reports what a password box holds") and `packages/agent/src/tools/browser.test.ts` ("never shows what a password box holds").

---

## File structure

**Desktop (`apps/desktop/src/`)**

- `site-session.mjs` — shared partition, Chrome user agent, a `capture()` method. Modify.
- `sign-in.mjs` — extend the fill so a username-only page (Google's first step) is handled. Modify.
- `page-actions.mjs` — a `sign_in` action and password-box routing, both through a `credentialsFor` seam. Modify.
- `operations.mjs` — shared partition label, supply `credentialsFor` to `actOnPage`, emit a frame after each browse/act. Modify.
- `main.mjs` — park the view visible when collapsed, forward frames as a `site-frame` event, keep the last frame for `siteSession`. Modify.
- `web-preload.cjs` — expose `onSiteFrame`. Modify.

**Web (`apps/web/src/`)**

- `lib/desktop.ts` — bridge types: `onSiteFrame`, `frame` on the session reply/event. Modify.
- `lib/useAgentSession.ts` — carry `frame` in the hook state. Modify.
- `screens/AgentSession.tsx` — show the latest frame in the collapsed card. Modify.
- `index.css` — a rule for the frame image. Modify.
- `screens/SiteConnections.tsx` — drop the "not behind Google" copy; say Google is signed into once in the card. Modify.

**Agent (`packages/agent/src/`)**

- `tools/types.ts` — add `'sign_in'` to `BrowserAction['action']`. Modify.
- `tools/browser.ts` — accept `sign_in` in the schema, `problemWith`, `actionFrom`, `describeAction`, and the tool description. Modify.
- `prompts/browser.md` — rewrite the sign-in section. Modify.
- `run.ts` — update `SIGN_IN_SECTION`. Modify.

**Tests**

- `apps/desktop/src/site-session.test.mjs` — new, for `userAgentFor`.
- `apps/desktop/src/sign-in.test.mjs` — new, for the extended fill script.
- `apps/desktop/src/page-actions.test.mjs` — extend for `sign_in` and password routing.
- `packages/agent/src/tools/browser.test.ts` — extend for `sign_in`.
- `packages/agent/src/sign-in-prompt.test.ts` — update for the new prompt copy.
- `apps/web/src/screens/AgentSession.frame.test.tsx` — new, for the frame in the card.

---

## Task 1: The spike — shared profile, Chrome user agent, and a measured Google sign-in

This task lays the foundation the rest builds on, and answers the one question that cannot be known from the code: does Google's sign-in page accept the in-app browser once it is one shared profile with a Chrome user agent. Nothing after this task is worth building if the answer is no.

**Files:**

- Modify: `apps/desktop/src/site-session.mjs`
- Create: `apps/desktop/src/site-session.test.mjs`
- Modify: `apps/desktop/src/operations.mjs:226-231` (`browsePage` partition label)

**Interfaces:**

- Produces: `userAgentFor(fallback: string): string` exported from `site-session.mjs` — the Electron default user agent with the ` Electron/x.y.z` and ` ContextoAgent/x.y.z` tokens removed.
- Produces: `SHARED_PARTITION = 'persist:school'` exported from `site-session.mjs`.
- Changes: `SiteSession` launches on `SHARED_PARTITION` regardless of `portalId`; `portalId` stays the display/label field only.

- [ ] **Step 1: Write the failing test for `userAgentFor`**

Create `apps/desktop/src/site-session.test.mjs`:

```js
import { describe, expect, it } from 'vitest';
import { userAgentFor } from './site-session.mjs';

/**
 * Google's sign-in page refuses a browser that names itself Electron, and an
 * embedded-app token draws the same refusal. Everything else in the string is
 * an ordinary Chrome on macOS and must survive untouched, or we would be
 * spoofing rather than declining to lie.
 */
describe('userAgentFor', () => {
  const CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

  it('strips the Electron token', () => {
    const ua = userAgentFor(`${CHROME.replace('Chrome', 'Electron/39.8.10 Chrome')}`);
    expect(ua).not.toMatch(/Electron/);
  });

  it('strips the app-name token', () => {
    const withApp =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) ContextoAgent/0.0.0 Chrome/153.0.0.0 Electron/39.8.10 Safari/537.36';
    const ua = userAgentFor(withApp);
    expect(ua).not.toMatch(/ContextoAgent/);
    expect(ua).not.toMatch(/Electron/);
  });

  it('leaves an already-clean Chrome string unchanged', () => {
    expect(userAgentFor(CHROME)).toBe(CHROME);
  });

  it('keeps the Chrome and Safari tokens and single-spaces the result', () => {
    const withApp =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) ContextoAgent/0.0.0 Chrome/153.0.0.0 Electron/39.8.10 Safari/537.36';
    const ua = userAgentFor(withApp);
    expect(ua).toMatch(/Chrome\/153\.0\.0\.0/);
    expect(ua).toMatch(/Safari\/537\.36/);
    expect(ua).not.toMatch(/ {2}/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/desktop/src/site-session.test.mjs`
Expected: FAIL — `userAgentFor` is not exported.

- [ ] **Step 3: Add `userAgentFor` and `SHARED_PARTITION`**

At the top of `apps/desktop/src/site-session.mjs`, after the imports:

```js
/**
 * One store for everything the agent's browser does, the way a Chrome profile
 * is one store. A session signed into a site stays signed in, and Sign in with
 * Google carries from one site to the next -- which per-site partitions could
 * never do. The label a conversation shows is still the site's; only the store
 * is shared.
 */
export const SHARED_PARTITION = 'persist:school';

/**
 * A user agent Google's sign-in page will accept.
 *
 * Measured: Google answers a browser that names itself Electron with "This
 * browser or app may not be secure" and stops. The rest of Electron's default
 * string is an ordinary Chrome on this OS, so we remove the two tokens that
 * give it away -- Electron's own, and the embedding app's -- and change
 * nothing else. Not a spoof: what is left is true.
 */
export function userAgentFor(fallback) {
  return fallback
    .replace(/\s(?:Electron|ContextoAgent)\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run the `userAgentFor` test to green**

Run: `pnpm vitest run apps/desktop/src/site-session.test.mjs`
Expected: PASS.

- [ ] **Step 5: Use the shared partition and set the user agent in `launch()`**

In `apps/desktop/src/site-session.mjs`, change the `WebContentsView` partition from `` `persist:site-${this.portalId}` `` to `SHARED_PARTITION`. Then, after `const wc = this.webContents;`, set the user agent on that partition's session once:

```js
// Set once for the shared session; harmless to repeat. app.userAgentFallback
// is Electron's default string for this build, which userAgentFor cleans.
const ua = userAgentFor(app.userAgentFallback);
wc.session.setUserAgent(ua);
```

Add `app` to the electron import at the top: `import { WebContentsView, app } from 'electron';`. Update the class docstring's "Each site gets its own persistent partition" paragraph to say the sessions now share one store, and why (one line: so a Google sign-in carries across sites).

- [ ] **Step 6: Point `browsePage`'s label at the host, not a throwaway partition**

In `apps/desktop/src/operations.mjs`, in `browsePage`, the `partition` local is now only a display/grouping label, no longer a store name. Change the comment and the fallback so a non-connected page is labelled by its host rather than the literal `'agent-browsing'`:

```js
const site = listPortals().find((p) => p.origin === target.origin);
// Only a label now: the store is shared (SHARED_PARTITION). A connected site
// shows its name; anything else shows its host.
const partition = site ? site.id : target.host;
```

Leave the `same`/`resumeBrowser` logic below it unchanged — it compares this label, which still distinguishes one site from another within a conversation.

- [ ] **Step 7: Run the desktop suite**

Run: `pnpm vitest run apps/desktop`
Expected: PASS. If `operations.test.mjs` asserts on the old `'agent-browsing'` string or a `persist:site-` partition, update that assertion to the new label; those tests do not currently reference either (verified: they cover `portalIdFor`, `forgetDevice`, `coalesce`, `showsInChat`, `oneAtATime`).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/site-session.mjs apps/desktop/src/site-session.test.mjs apps/desktop/src/operations.mjs
git commit -m "One shared profile for the agent's browser, with a user agent Google accepts"
```

- [ ] **Step 9: MANUAL MEASUREMENT — Google accepts the browser**

This is the spike's whole point; do it before building anything else.

```bash
cd apps/desktop && pnpm start
```

In the app, start a conversation and ask the agent to open a page on a site that signs in through Google (the wearelcc.ca school portal, or `https://accounts.google.com`). When the sign-in page appears, open the browser card and sign in to the wearelcc.ca Google account by hand.

- **PASS:** Google lets you through to the account. Record it and continue to Task 2.
- **FAIL:** Google shows "This browser or app may not be secure." **Stop.** The remaining tasks assume Google works in this view. Report the failure to the user: the only route left to SSO is a second Chrome on a copied school profile, which the spec rejects, so the decision returns to them. Do not proceed.

- [ ] **Step 10: MANUAL MEASUREMENT — a parked view still captures**

Still in the running app, confirm that `webContents.capturePage()` returns an image when the view is positioned mostly outside the window (a prior probe found a hidden or fully off-window view returns null). With the browser card collapsed, add a temporary line to `applySiteViewBounds`'s parked branch (see Task 4) or evaluate in the main process console:

```js
activeSession.view.setBounds({
  x: mainWindow.getContentSize()[0] - 1,
  y: 0,
  width: 1200,
  height: 800,
});
activeSession.view.setVisible(true);
const img = await activeSession.view.webContents.capturePage();
console.log('capture size', img.getSize());
```

- **PASS (non-zero size):** the one-pixel-in-window parking in Task 4 will produce frames. Note it.
- **FAIL (empty/zero):** frames can only be captured while the card is open. Note it; Task 4 and Task 6 each say what to do in that case.

No commit — this is a measurement. Remove any temporary probe line.

---

## Task 2: `sign_in` fills a login form from the keychain

**Files:**

- Modify: `apps/desktop/src/sign-in.mjs`
- Create: `apps/desktop/src/sign-in.test.mjs`
- Modify: `apps/desktop/src/page-actions.mjs` (add the `sign_in` case and the `credentialsFor` seam; route a password-box `type` through the same path)
- Modify: `apps/desktop/src/page-actions.test.mjs` (extend)
- Modify: `apps/desktop/src/operations.mjs` (`actOnPage` supplies `credentialsFor`)

**Interfaces:**

- Consumes: `SiteSession#evaluate(expression)`, `SiteSession#cdp`, `SiteSession#webContents` (from Task 1 / existing).
- Produces: `signInScript(username, password): string` in `sign-in.mjs` — page JS that fills whatever the page asks for and submits, returning `'submitted'` (both fields filled), `'submitted-username'` (only a username/email field present, filled and submitted), or a failure code (`'no-sign-in-field'`).
- Produces: `performAction(session, action, { credentialsFor } = {})` — `credentialsFor(origin: string): { username, password } | null | Promise<...>`. New action `{ action: 'sign_in' }` takes no `ref`. A `type` on a password box routes here instead of refusing.

- [ ] **Step 1: Write the failing test for `signInScript`**

Create `apps/desktop/src/sign-in.test.mjs`:

```js
// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import { signInScript } from './sign-in.mjs';

/** Run the built script against the current jsdom document. */
const run = (u, p) => eval(signInScript(u, p));

describe('signInScript', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('fills username and password and reports submitted', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="u" />
        <input type="password" name="p" />
        <button type="submit">In</button>
      </form>`;
    const out = run('alice', 'hunter2');
    expect(out).toBe('submitted');
    expect(document.querySelector('input[type=text]').value).toBe('alice');
    expect(document.querySelector('input[type=password]').value).toBe('hunter2');
  });

  it('fills only the address on a username-first page', () => {
    document.body.innerHTML = `
      <form>
        <input type="email" name="email" />
        <button type="submit">Next</button>
      </form>`;
    const out = run('alice@example.com', 'hunter2');
    expect(out).toBe('submitted-username');
    expect(document.querySelector('input[type=email]').value).toBe('alice@example.com');
  });

  it('reports when there is no sign-in field at all', () => {
    document.body.innerHTML = `<p>Nothing to sign into here.</p>`;
    expect(run('alice', 'hunter2')).toBe('no-sign-in-field');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/desktop/src/sign-in.test.mjs`
Expected: FAIL — `signInScript` is not exported.

- [ ] **Step 3: Add `signInScript`, built on the existing filler**

`sign-in.mjs` already has `fillScript(username, password)` (fills user+password, submits, returns `'submitted'` / `'no-password-field'` / `'no-username-field'`) and `explainFailure`. Add `signInScript`, reusing the same set-through-the-prototype-setter approach so there is one way of filling a form:

```js
/**
 * Fill whatever sign-in the page is showing, and submit it.
 *
 * A page with a password box is the ordinary case: username before it, then
 * the password. A page with only an email or text box is Google's first step,
 * which asks for the address and shows the password on the next page -- fill
 * it and go on. Anything else is not a sign-in, and says so.
 */
export function signInScript(username, password) {
  return `(() => {
    const setter = (el, value) => {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      set ? set.call(el, value) : (el.value = value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const submitOf = (form) =>
      form.querySelector('button[type=submit], input[type=submit]')
        ?? Array.from(form.querySelectorAll('button')).find((b) => !b.type || b.type === 'submit');
    const go = (form) => {
      const b = submitOf(form);
      if (b) b.click();
      else if (form.requestSubmit) form.requestSubmit();
      else if (form.submit) form.submit();
    };
    const pw = document.querySelector('input[type=password]');
    if (pw) {
      const form = pw.form ?? document;
      const inputs = Array.from(form.querySelectorAll('input'));
      const before = inputs.slice(0, inputs.indexOf(pw)).reverse();
      const user = before.find((i) => /^(text|email|tel)$/.test(i.type) && !i.disabled)
        ?? form.querySelector('input[type=email], input[type=text]');
      if (user) setter(user, ${JSON.stringify(username)});
      setter(pw, ${JSON.stringify(password)});
      go(form.requestSubmit || form.submit ? form : document.querySelector('form') ?? document.createElement('form'));
      return 'submitted';
    }
    const user = document.querySelector('input[type=email], input[type=text], input[type=tel]');
    if (user && !user.disabled) {
      setter(user, ${JSON.stringify(username)});
      const form = user.form;
      if (form) go(form); else user.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'submitted-username';
    }
    return 'no-sign-in-field';
  })()`;
}
```

Note: keep the existing `fillScript` as it is (still used by `autoSignIn`); `signInScript` is the superset the interactive path needs. If you prefer one function, that is a follow-up — do not change `autoSignIn`'s behaviour in this task.

- [ ] **Step 4: Run the `signInScript` test to green**

Run: `pnpm vitest run apps/desktop/src/sign-in.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing `page-actions` tests for `sign_in` and password routing**

In `apps/desktop/src/page-actions.test.mjs`, add a describe block. The existing `fakeSession(answer)` answers any script through `answer(script)` and records CDP sends; extend a case where `evaluate` returns the sign-in origin and outcome. Add:

```js
describe('signing in', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const origin = 'https://studyo.app';

  /** A page that reports its origin and then that the fill submitted. */
  const signInPage =
    (outcome = 'submitted') =>
    (script) =>
      script.includes('location.origin')
        ? JSON.stringify({ origin })
        : script.includes('input[type=password]') || script.includes('input[type=email]')
          ? JSON.stringify(outcome)
          : SNAP;

  it('reads the keychain for the page origin and fills the form', async () => {
    const session = fakeSession(signInPage());
    const seen = [];
    const credentialsFor = (o) => {
      seen.push(o);
      return { username: 'alice', password: 'hunter2' };
    };
    await runAction(session, { action: 'sign_in' }, { credentialsFor });
    expect(seen).toEqual([origin]);
    // The fill ran (the script carrying the credentials was evaluated).
    expect(session.evaluate.mock.calls.some((c) => c[0].includes('hunter2'))).toBe(true);
  });

  it('refuses with guidance when nothing is saved for the origin', async () => {
    const session = fakeSession(signInPage());
    await expect(
      runAction(session, { action: 'sign_in' }, { credentialsFor: () => null }),
    ).rejects.toThrow(/no saved sign-in/i);
  });

  it('routes a type into a password box through the same sign-in, ignoring the agent text', async () => {
    const session = fakeSession((script) =>
      script.includes('data-contexto-ref') && script.includes('password')
        ? JSON.stringify({ password: true })
        : script.includes('location.origin')
          ? JSON.stringify({ origin })
          : JSON.stringify({ ok: true, ...(script.includes('input[type=password]') ? {} : {}) }),
    );
    const credentialsFor = () => ({ username: 'alice', password: 'hunter2' });
    await runAction(
      session,
      { action: 'type', ref: 5, text: 'whatever the agent typed' },
      { credentialsFor },
    );
    // The agent's text never went to the page; the saved password did.
    expect(session.evaluate.mock.calls.some((c) => c[0].includes('whatever the agent typed'))).toBe(
      false,
    );
    expect(session.evaluate.mock.calls.some((c) => c[0].includes('hunter2'))).toBe(true);
  });
});
```

Add a helper near `act` that threads options:

```js
async function runAction(session, action, opts) {
  const done = performAction(session, action, opts);
  done.catch(() => {});
  await vi.runAllTimersAsync();
  return done;
}
```

- [ ] **Step 6: Run them and watch them fail**

Run: `pnpm vitest run apps/desktop/src/page-actions.test.mjs -t "signing in"`
Expected: FAIL — `performAction` ignores the options and has no `sign_in` case; a password-box `type` still throws.

- [ ] **Step 7: Implement the seam and the `sign_in` case**

In `apps/desktop/src/page-actions.mjs`, import the script: `import { signInScript, explainFailure } from './sign-in.mjs';` (adjust the existing import if `explainFailure` is already imported elsewhere — it is not in this file today).

Add a helper that runs a sign-in from resolved credentials:

```js
/** Read the page's origin, so a saved sign-in only ever reaches its own site. */
const ORIGIN = `JSON.stringify({ origin: location.origin })`;

async function signInFromKeychain(session, credentialsFor) {
  const { origin } = await run(session, ORIGIN);
  const creds = origin ? await credentialsFor?.(origin) : null;
  if (!creds) {
    throw new ActionError(
      'There is no saved sign-in for this site. Tell the student they can sign in once in the ' +
        'browser card and it stays signed in, or save a sign-in in Settings, Connections, Sites.',
    );
  }
  const outcome = await session.evaluate(signInScript(creds.username, creds.password));
  if (outcome !== 'submitted' && outcome !== 'submitted-username') {
    throw new ActionError(
      'This page is not asking for a sign-in that could be filled. Look at the page again.',
    );
  }
}
```

In the `type` function, replace the password-box refusal (the `if (box.password) throw new ActionError(...)` block) with a route through the sign-in, discarding the agent's text:

```js
if (box.password) {
  // A password box is never typed into with the agent's text. The saved
  // sign-in is filled instead, from the keychain, on this machine.
  await signInFromKeychain(session, credentialsFor);
  return;
}
```

`type` must receive `credentialsFor`. Change its signature to `async function type(session, ref, text, submit, credentialsFor)` and pass it through from `performAction`.

In `performAction`, change the signature and add the case:

```js
export async function performAction(session, action, { credentialsFor } = {}) {
  const wc = session.webContents;
  const kind = action?.action;
  // ...existing ref/needsRef setup...

  switch (kind) {
    // ...existing cases, but 'type' now forwards credentialsFor:
    case 'type':
      needsRef();
      if (typeof action.text !== 'string') throw new ActionError('type needs the text to type.');
      await settle(wc, () =>
        type(session, ref, action.text, Boolean(action.submit), credentialsFor),
      );
      break;
    case 'sign_in':
      await settle(wc, () => signInFromKeychain(session, credentialsFor));
      break;
    // ...
  }
  return snapshot(session);
}
```

- [ ] **Step 8: Supply `credentialsFor` from `operations.actOnPage`**

In `apps/desktop/src/operations.mjs`, `actOnPage` calls `performAction(browser, action)`. Give it the resolver, which is where the exact-origin match and the keychain read live (keeping both off the agent and off the server):

```js
const read = await performAction(browser, action, {
  credentialsFor: (origin) => {
    // Exact origin, never a suffix: a saved sign-in reaches its own site
    // and no other, whatever page is asking.
    const site = listPortals().find((p) => p.origin === origin);
    return site ? readCredentials(site.id) : null;
  },
});
```

`readCredentials` is already imported in `operations.mjs`.

- [ ] **Step 9: Run the desktop suite to green**

Run: `pnpm vitest run apps/desktop`
Expected: PASS, including the existing "never reports what a password box holds" test.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/sign-in.mjs apps/desktop/src/sign-in.test.mjs apps/desktop/src/page-actions.mjs apps/desktop/src/page-actions.test.mjs apps/desktop/src/operations.mjs
git commit -m "The machine types the saved sign-in when a page asks for one"
```

---

## Task 3: The agent can ask for a sign-in

**Files:**

- Modify: `packages/agent/src/tools/types.ts:127-136` (`BrowserAction`)
- Modify: `packages/agent/src/tools/browser.ts` (schema enum, `problemWith`, `describeAction`, tool description)
- Modify: `packages/agent/src/tools/browser.test.ts` (extend)

**Interfaces:**

- Consumes: the `sign_in` desktop action from Task 2.
- Produces: `browser_act` accepts `{ action: 'sign_in' }` with no `ref`; the action travels to the device unchanged.

- [ ] **Step 1: Write the failing agent tests**

In `packages/agent/src/tools/browser.test.ts`, add to the `browser_act` describe and the `describeAction` describe:

```ts
it('accepts sign_in with no element number', async () => {
  const portals = fakePortals(); // whatever the file already uses to stub ctx.portals
  const res = await actInBrowser.execute({ action: 'sign_in' }, ctxWith(portals));
  // It did not bounce the call back as malformed.
  expect(res).not.toMatchObject({ acted: false });
});

it('describes a sign-in in words', () => {
  expect(describeAction({ action: 'sign_in' })).toMatch(/sign|log/i);
});
```

Match the file's existing helpers for building `ctx` and the fake `portals`; mirror the neighbouring `sends the action as given` test for the wiring.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run packages/agent/src/tools/browser.test.ts`
Expected: FAIL — the schema rejects `'sign_in'`, and `describeAction` has no case for it (TypeScript-exhaustive switch throws or returns undefined).

- [ ] **Step 3: Add `sign_in` to the type**

In `packages/agent/src/tools/types.ts`, extend the union:

```ts
action: 'click' | 'type' | 'press' | 'select' | 'scroll' | 'back' | 'look' | 'sign_in';
```

- [ ] **Step 4: Add it to the schema, `problemWith`, and `describeAction`**

In `packages/agent/src/tools/browser.ts`:

- Add `'sign_in'` to the `z.enum([...])` in `actInput`.
- `problemWith`: `sign_in` needs nothing, so it falls through the `default: return null`. No change required, but add an explicit `case 'sign_in': return null;` for clarity.
- `actionFrom`: no new fields, no change.
- `describeAction`: add

```ts
    case 'sign_in':
      return 'signed in with their saved sign-in';
```

- [ ] **Step 5: Update the `browser_act` description**

In the `actInBrowser.description`, add `sign_in` to the list of actions and replace the "Nothing is ever typed into a password box" sentence:

Add to the action list: `sign_in (fill in the saved sign-in for this site and submit it -- use this when a page asks to be signed in)`.

Replace the password sentence with:

```
'When a page asks for a sign-in, use sign_in: their computer fills the sign-in they saved for ' +
'that site and never shows you the password. '
```

- [ ] **Step 6: Run the agent suite to green**

Run: `pnpm vitest run packages/agent/src/tools/browser.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS — the exhaustive `describeAction` switch now covers `sign_in`.

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/tools/types.ts packages/agent/src/tools/browser.ts packages/agent/src/tools/browser.test.ts
git commit -m "browser_act gains sign_in, so the agent can ask the machine to sign in"
```

---

## Task 4: A picture after every step

Only build this once Task 1 Step 10 recorded whether a parked view captures. This task assumes it does (a one-pixel-in-window parked view yields frames). If Step 10 recorded FAIL, make the capture conditional on the card being open — see Step 8's note.

**Files:**

- Modify: `apps/desktop/src/site-session.mjs` (a `capture()` method)
- Modify: `apps/desktop/src/operations.mjs` (a `frame` observer; capture after browse/act)
- Modify: `apps/desktop/src/main.mjs` (park visible when collapsed; forward `site-frame`; keep last frame for `siteSession`)
- Modify: `apps/desktop/src/web-preload.cjs` (`onSiteFrame`)

**Interfaces:**

- Produces: `SiteSession#capture(): Promise<string | null>` — a `data:image/jpeg;base64,...` URL at half scale, or null if the view cannot be captured.
- Produces: `observeSessions({ open, close, frame })` — `frame(session, dataUrl)` is optional; the CLI sets none.
- Produces: renderer event `site-frame` with `{ agentId, portalId, title, url, frame }`; `siteSession` invoke reply gains `frame`.
- Produces: bridge `onSiteFrame(fn)` returning an unsubscribe function; `getSiteSession()` reply gains `frame?: string`.

- [ ] **Step 1: Add `capture()` to `SiteSession`**

In `apps/desktop/src/site-session.mjs`:

```js
  /**
   * A still of the page, small, or null when there is nothing to capture.
   *
   * capturePage returns nothing for a view that is not being drawn -- hidden,
   * or entirely off the window -- so this is only ever called on a view the
   * window is parking on screen. Half scale because it is a thumbnail in a
   * chat card, not the page itself.
   */
  async capture() {
    const wc = this.webContents;
    if (!wc || wc.isDestroyed()) return null;
    try {
      const image = await wc.capturePage();
      if (image.isEmpty()) return null;
      const { width } = image.getSize();
      const small = width > 1 ? image.resize({ width: Math.round(width / 2) }) : image;
      return `data:image/jpeg;base64,${small.toJPEG(60).toString('base64')}`;
    } catch {
      return null;
    }
  }
```

- [ ] **Step 2: Emit a frame after each browse and act**

In `apps/desktop/src/operations.mjs`:

- Add `let onSessionFrame = null;` beside `onSessionOpen`/`onSessionClose`, and accept it: `export function observeSessions({ open, close, frame }) { onSessionOpen = open; onSessionClose = close; onSessionFrame = frame; }`.
- Add a helper:

```js
/** Hand the app a still of the page, if anyone is watching and it captured. */
async function reportFrame(browser) {
  if (!onSessionFrame || !browser?.view || !showsInChat(browser)) return;
  const frame = await browser.capture();
  if (frame) onSessionFrame(browser, frame);
}
```

- In `browsePage`, after `const read = await evaluate(browser, SNAPSHOT_SCRIPT);` and before `await browser.close();`, add `await reportFrame(browser);`.
- In `actOnPage`, after `const read = await performAction(browser, action, {...});` and before `await browser.close();`, add `await reportFrame(browser);`.

- [ ] **Step 3: Park the view visible when collapsed**

In `apps/desktop/src/main.mjs`, `applySiteViewBounds` currently hides the view when `siteViewBounds` is null. Change the null branch to park it one pixel inside the window instead, so it composites and can be captured but shows nothing the student reads as a live browser:

```js
if (!siteViewBounds) {
  // Parked, not hidden: a hidden view yields no capture, and the card shows
  // a still instead of the live view while collapsed. One pixel inside the
  // window is enough to keep it drawn and effectively out of sight.
  const [w] = mainWindow.getContentSize();
  activeSession.view.setVisible(true);
  activeSession.view.setBounds({ x: w - 1, y: 0, width: 1200, height: 800 });
  return;
}
```

- [ ] **Step 4: Forward frames and remember the last one**

In `apps/desktop/src/main.mjs`:

- Add `let lastFrame = null;` beside `activeSession`.
- Add a frame observer function and wire it in `observeSessions`:

```js
function sendSiteFrame(session, frame) {
  lastFrame = frame;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('site-frame', {
    agentId: session.agentId,
    portalId: session.portalId,
    title: session.view?.webContents?.getTitle?.() ?? '',
    url: session.view?.webContents?.getURL?.() ?? '',
    frame,
  });
}
```

Change the wiring in `app.whenReady` from `observeSessions({ open: attachSiteView, close: markSiteViewIdle });` to `observeSessions({ open: attachSiteView, close: markSiteViewIdle, frame: sendSiteFrame });`.

- Clear `lastFrame = null;` in `attachSiteView` when a different session replaces the active one (inside the `if (activeSession && activeSession !== session)` block).
- Add `frame: lastFrame` to the `siteSession` invoke reply object.

- [ ] **Step 5: Expose `onSiteFrame` on the bridge**

In `apps/desktop/src/web-preload.cjs`, add beside `onSiteSession`:

```js
  onSiteFrame: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('site-frame', handler);
    return () => ipcRenderer.removeListener('site-frame', handler);
  },
```

- [ ] **Step 6: Manually verify frames arrive**

Run: `cd apps/desktop && pnpm start`, ask the agent to open a page, and confirm in the main-process log (add a temporary `console.log` in `sendSiteFrame`) that a `site-frame` fires after the open and after each act, with a non-empty `frame`. Remove the temporary log.

There is no desktop unit test for capture: it needs a real `WebContentsView` and a compositor, which Vitest does not have. The manual check is the verification, consistent with how the streaming path was verified before.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/site-session.mjs apps/desktop/src/operations.mjs apps/desktop/src/main.mjs apps/desktop/src/web-preload.cjs
git commit -m "The machine sends a still of the page after every browser step"
```

- [ ] **Step 8: If Task 1 Step 10 recorded FAIL (a parked view does not capture)**

Do not park the view. Instead capture only when the card is open: in `AgentSession.tsx` (Task 6) the view is already made visible on expand, so `reportFrame` will succeed then and return null (no frame sent) while collapsed. Leave `applySiteViewBounds`'s null branch as `setVisible(false)`, keep `reportFrame` as written (it returns null harmlessly), and note in the commit that live frames appear only while the card is open. The rest of the plan is unchanged.

---

## Task 5: The card shows the latest frame

**Files:**

- Modify: `apps/web/src/lib/desktop.ts` (types)
- Modify: `apps/web/src/lib/useAgentSession.ts` (carry `frame`)
- Modify: `apps/web/src/screens/AgentSession.tsx` (render it)
- Modify: `apps/web/src/index.css` (image rule)
- Create: `apps/web/src/screens/AgentSession.frame.test.tsx`

**Interfaces:**

- Consumes: `onSiteFrame`, `getSiteSession().value.frame`, `onSiteSession` (from Task 4).
- Produces: `AgentSessionState` gains `frame?: string`; the collapsed card renders it when present.

- [ ] **Step 1: Extend the bridge types**

In `apps/web/src/lib/desktop.ts`:

- `getSiteSession()` reply `value` gains `frame?: string | null`.
- Add to `DesktopBridge`:

```ts
  /** A still of the page the agent is on. The site cannot send this. */
  onSiteFrame?(
    fn: (payload: {
      agentId?: string | null;
      portalId?: string;
      title?: string;
      url?: string;
      frame: string;
    }) => void,
  ): (() => void) | undefined;
```

- [ ] **Step 2: Write the failing hook/card test**

Create `apps/web/src/screens/AgentSession.frame.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSession } from './AgentSession.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AGENT = 'a1';
const FRAME = 'data:image/jpeg;base64,AAAA';

/** A desktop bridge that reports a showing session with a frame. */
function stubBridge() {
  (window as unknown as { contextoDesktop: unknown }).contextoDesktop = {
    version: 1,
    listSites: async () => [],
    addSite: async () => ({ ok: true }),
    removeSite: async () => ({ ok: true }),
    beginLogin: async () => ({ ok: true }),
    finishLogin: async () => ({ ok: true }),
    syncSite: async () => ({ ok: true }),
    onSitesChanged: () => {},
    getSiteSession: async () => ({
      ok: true,
      value: { active: true, showing: true, portalId: 'studyo', agentId: AGENT, frame: FRAME },
    }),
    onSiteSession: () => () => {},
    onSiteFrame: () => () => {},
    setSiteViewBounds: async () => ({}),
  };
}

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  stubBridge();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { contextoDesktop?: unknown }).contextoDesktop;
});

describe('the browser card', () => {
  it('shows the latest frame when collapsed', async () => {
    await act(async () => {
      root.render(<AgentSession agentId={AGENT} working={true} />);
    });
    const img = container.querySelector('img.agent-browser-still') as HTMLImageElement | null;
    expect(img?.src).toBe(FRAME);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run apps/web/src/screens/AgentSession.frame.test.tsx`
Expected: FAIL — no `img.agent-browser-still` is rendered.

- [ ] **Step 4: Carry `frame` in the hook**

In `apps/web/src/lib/useAgentSession.ts`:

- Add `frame?: string;` to `AgentSessionState`.
- In the `getSiteSession().then`, set `frame: now.frame ?? undefined` in `setState`.
- In the `onSiteSession` handler, preserve any existing frame: `setState((s) => ({ active: payload.active, showing: payload.active || Boolean(payload.showing), portalId: payload.portalId, frame: s.frame }));` (switch the setter to the callback form).
- Add a second subscription for frames:

```ts
const stopFrame = bridge?.onSiteFrame?.((payload) => {
  if (!belongsInChat(payload.agentId, agentId)) return;
  setState((s) => ({ ...s, showing: true, frame: payload.frame }));
});
return () => {
  stop?.();
  stopFrame?.();
};
```

- [ ] **Step 5: Render the frame in the collapsed card**

In `apps/web/src/screens/AgentSession.tsx`:

- Pull `frame` from the hook: `const { active, showing, portalId, frame } = useAgentSession(agentId);`.
- In the collapsed `<button>`, replace the `.agent-browser-preview` block's placeholder icon/text with the frame when there is one, keeping the text fallback when there is not:

```tsx
<span className="agent-browser-preview">
  {frame ? (
    <img className="agent-browser-still" src={frame} alt="" />
  ) : (
    <>
      <span className="agent-browser-preview-icon" aria-hidden="true">
        {/* existing svg */}
      </span>
      <span className="agent-browser-preview-text">
        {lit ? `Working in ${site}…` : 'Click to open'}
      </span>
    </>
  )}
</span>
```

- [ ] **Step 6: Style the still**

In `apps/web/src/index.css`, near `.agent-browser-preview`:

```css
.agent-browser-still {
  display: block;
  width: 100%;
  height: 100%;
  max-height: 12rem;
  object-fit: cover;
  object-position: top center;
}
```

- [ ] **Step 7: Run the web test to green**

Run: `pnpm vitest run apps/web/src/screens/AgentSession.frame.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the web suite and typecheck**

Run: `pnpm vitest run apps/web && pnpm -r typecheck`
Expected: PASS. The existing `useAgentSession.test.ts` (`belongsInChat`) is unaffected.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/desktop.ts apps/web/src/lib/useAgentSession.ts apps/web/src/screens/AgentSession.tsx apps/web/src/index.css apps/web/src/screens/AgentSession.frame.test.tsx
git commit -m "The conversation card shows a still of the page after each step"
```

---

## Task 6: The prompt and the Sites copy

**Files:**

- Modify: `packages/agent/src/prompts/browser.md` (sign-in section)
- Modify: `packages/agent/src/run.ts` (`SIGN_IN_SECTION`)
- Modify: `packages/agent/src/sign-in-prompt.test.ts` (update expectations)
- Modify: `apps/web/src/screens/SiteConnections.tsx` (drop the Google copy)

**Interfaces:**

- Consumes: the `sign_in` action (Task 3). The prompt must name it and stop claiming Google sites cannot be connected.

- [ ] **Step 1: Update the sign-in-prompt tests first**

In `packages/agent/src/sign-in-prompt.test.ts`, the suite asserts `SIGN_IN_SECTION` contains `/no manual sign-in/i`. That claim stops being true — Google is now a manual sign-in done once in the card. Change that expectation and add one for the card:

```ts
it('tells it not to send the student off to sign in by hand for a saved site', () => {
  expect(SIGN_IN_SECTION).toMatch(/must never ask for it/i);
});

it('names signing into Google once in the browser card', () => {
  expect(SIGN_IN_SECTION).toMatch(/browser card/i);
});
```

Keep the "never say you cannot handle a password", "You CAN get at those sites", "keychain", "you never see it", "load the browser skill", and length-under-700 assertions.

In the `what the browser skill adds` describe, add:

```ts
it('tells the agent to use sign_in when a page asks to be signed in', () => {
  expect(BROWSER.body).toMatch(/sign_in/);
});

it('no longer claims a Google site cannot be connected', () => {
  expect(BROWSER.body).not.toMatch(/cannot get past/i);
});
```

- [ ] **Step 2: Run the prompt tests and watch them fail**

Run: `pnpm vitest run packages/agent/src/sign-in-prompt.test.ts`
Expected: FAIL — the old copy still says "no manual sign-in" and "cannot get past", and never mentions `sign_in` or the browser card.

- [ ] **Step 3: Rewrite `browser.md`'s sign-in section**

Replace the three paragraphs under `## Sign-in` (lines 38-42) with:

```markdown
Their username and password for a site are saved on their own computer, in its keychain. You never see it, are never given it, and must never ask for it. When a page asks to be signed in, call `browser_act` with `sign_in`: their computer fills the saved sign-in for that site and hands you back the page. So never say you cannot handle a password or cannot log in -- neither is true here.

If a site has no saved sign-in -- `sign_in` comes back saying so -- tell them they can sign in once in the browser card and it stays signed in, or save a sign-in in Settings, Connections, Sites.

A site behind Google or another single sign-on is signed into once, by them, in the browser card: a typed password cannot get past the step that follows it. After that the browser stays signed in and you can open the site like any other. Say that plainly rather than trying to type a Google sign-in, and do not tell them Google sites cannot be connected.
```

Also update the description line's "signing in to" phrasing only if needed; it already covers sign-in. And in `## The four tools`, `browser_act`'s sentence gains `sign_in`: after "Go back a page." add "Sign in to the site with their saved sign-in." Update line 8's list of what the browser can do if you like, but it need not change.

- [ ] **Step 4: Rewrite `SIGN_IN_SECTION` in `run.ts`**

Replace the constant's body so it stays under 700 characters, keeps the phrases the tests pin, drops "no manual sign-in", and names the card:

```ts
export const SIGN_IN_SECTION =
  'Sites that need a login:\n' +
  'Some of what this student needs is behind a sign-in -- a school portal, a course site. ' +
  'They have saved the username and password for those on their own computer, in its ' +
  'keychain. You never see it, are never given it, and must never ask for it. You CAN get ' +
  'at those sites: their computer signs in for you when a page asks. Never say you cannot ' +
  'handle a password or cannot log in. A site behind Google is signed into once, by them, in ' +
  'the browser card, and then stays signed in. Load the browser skill before you open, check, ' +
  'sign in to, or do anything on any site.';
```

Confirm the length: `node -e "console.log(require('...').SIGN_IN_SECTION?.length)"` is awkward for a `.ts` const, so rely on the test's `toBeLessThan(700)`.

- [ ] **Step 5: Run the prompt tests to green**

Run: `pnpm vitest run packages/agent/src/sign-in-prompt.test.ts`
Expected: PASS.

- [ ] **Step 6: Drop the "not behind Google" copy in Sites settings**

In `apps/web/src/screens/SiteConnections.tsx`:

- The `alert` after adding a site (around line 181) appends "If the site signs in through Google, a username and password cannot get past it." Replace that sentence with "If the site signs in through Google, sign in once in the browser card and it stays signed in."
- The two `.saved-signin` help paragraphs (around lines 228-232 and 264-268) end "not ones behind Google." Change both to end "For a site behind Google, sign in once in the browser card." Keep the "kept in your Mac's keychain, never sent to Contexto Agent" part.

- [ ] **Step 7: Run the agent and web suites, typecheck, format**

Run: `pnpm vitest run packages/agent apps/web && pnpm -r typecheck && pnpm format:check`
Expected: PASS. Run `pnpm format` if `format:check` reports changes, then re-run it.

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/prompts/browser.md packages/agent/src/run.ts packages/agent/src/sign-in-prompt.test.ts apps/web/src/screens/SiteConnections.tsx
git commit -m "Prompt and Sites copy: sign in with sign_in, and Google once in the card"
```

---

## Task 7: Whole-app verification on this Mac

**Files:** none (verification only).

- [ ] **Step 1: Full suite, types, lint, format**

Run: `pnpm test && pnpm -r typecheck && pnpm lint && pnpm format:check`
Expected: all PASS. Fix anything that fails before continuing.

- [ ] **Step 2: The real check — Studyo from signed out**

Run: `cd apps/desktop && pnpm start`. In Settings, Connections, Sites, forget the saved Studyo session if one is signed in (or use the browser card to sign out), so Studyo starts signed out but its keychain sign-in is still saved. Then, in a conversation, ask the agent to open Studyo and check something behind the login.

Expected: the agent opens Studyo, hits the login, calls `sign_in`, the machine types the saved username and password, the page proceeds, and the agent answers from the signed-in page. The card shows a still after each step. Watch that the agent never states a password and never says it cannot log in.

- [ ] **Step 3: The Google carry-over**

With the wearelcc.ca Google account signed in by hand (from Task 1), ask the agent to open a different school site that signs in through that Google account. Expected: it opens signed in, without a second Google prompt, because the shared profile holds the session.

- [ ] **Step 4: Record the outcome**

Note what passed and anything that did not, for the finishing-the-branch step. If Task 1's Google measurement had failed, this plan would have stopped there; reaching here means it passed.

---

## Self-review

**Spec coverage:**

- One profile → Task 1 (shared partition, label change). ✓
- A browser Google accepts → Task 1 (user agent) + manual measurement. ✓
- Signing in, typed by the machine; `sign_in`; `type` into a password box no longer refuses; exact-origin match; agent never sees the password → Task 2 (desktop) + Task 3 (agent tool). ✓
- Google signed in once by hand → Task 6 (prompt + copy); no code path types Google. ✓
- A picture after every step; parked view; capture; frame event; card render → Task 4 + Task 5. ✓
- Prompt and tool; `run.ts`; Sites copy → Task 3 (tool) + Task 6 (prompt, run.ts, copy). ✓
- Order: spike first → Task 1 is the spike with a hard stop. ✓
- Not in this build (real Chrome, saved Google sign-in, live video, removing old partitions) → none added. ✓

**Placeholder scan:** No TBD/TODO. Every code step carries the actual code. The two capture-related steps that cannot be unit-tested (real compositor) are marked manual, with the reason.

**Type consistency:** `sign_in` is the action name across `BrowserAction` (Task 3), the desktop `performAction` switch (Task 2), and the prompt (Task 6). `credentialsFor(origin)` has the same signature in `page-actions.mjs` and where `operations.mjs` supplies it. `capture()`, `onSessionFrame`/`frame`, `site-frame`, `onSiteFrame`, and `frame?: string` on `AgentSessionState` line up across Tasks 4 and 5. `SHARED_PARTITION` / `userAgentFor` exported from `site-session.mjs` and used there.

**Known risk carried by the plan, not hidden:** the parked-view capture is genuinely uncertain and is measured in Task 1 Step 10; Task 4 Step 8 is the documented fallback. The Google acceptance is measured in Task 1 Step 9 with a hard stop.
