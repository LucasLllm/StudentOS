# Browser & Sign-in Diagnostics Implementation Plan (Part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every browser / sign-in attempt the desktop app makes ends in exactly one explained outcome — `ok`, or `failed` with a code from a closed list — recorded step by step, stored locally and on the server, and readable by developers on a debug page and with `pnpm trace`.

**Architecture:** A trace recorder (`apps/desktop/src/trace.mjs`) runs each attempt inside an `AsyncLocalStorage` scope, so any code can `note()` a step or throw a coded `Failure` without threading a parameter. The attempt wrapper guarantees one outcome, redacts secrets, writes JSONL locally, then uploads to a new `browser_attempts` table. The server adds a heartbeat and a `picked_up_at` column so a wait that times out can say _why_ (offline / busy / never reported). A custom ESLint rule forbids unexplained `catch` blocks in the desktop source.

**Tech Stack:** Node ≥22 ESM (desktop, Electron 39), Hono + Drizzle + Postgres (api), React (web), Vitest, ESLint flat config.

**Spec:** Design agreed in conversation on 2026-10-09 (no spec file, at the user's request). Summary: Sections 1–4 — attempts with ordered steps, closed failure taxonomy, no silent catches, local-first trace then upload, heartbeat-based timeout classification, developer-only debug page + `pnpm trace`, 14-day screenshot retention, typed text never recorded.

**Part 2** (separate plan, written after Task 9's feasibility probe): Swift accessibility helper, real-Chrome driver, overlay cursor, permissions onboarding. Its code depends on what the probe proves, so it is not planned in detail here.

## Global Constraints

- Desktop code is plain `.mjs`, no build step, no new runtime dependencies.
- Typed text and passwords are never recorded: steps record lengths only; any string equal to a registered secret is replaced with `•••` before it is written anywhere.
- Only messages this app wrote travel to the agent. Raw error messages and stacks go to the trace (developer-only), never into `site_refresh_requests.result.reason`.
- Debug data is visible only to accounts whose email is in `DEVELOPER_EMAILS` (comma-separated env var).
- Screenshots: only the agent's own browser, only on failure, JPEG, deleted after 14 days with the attempt row.
- Local traces: `~/Library/Logs/ContextoAgent/traces/YYYY-MM-DD.jsonl`, overridable with `CONTEXTO_LOG_DIR` (tests must set it).
- Comment style: match the repo — explanatory block comments saying _why_, plain English, no emoji.

## Review Focus

1. Upload fails (offline) → trace must still exist locally and be retried later, never lost. Test in Task 3.
2. A `catch` that turns a real failure into success (e.g. `did-fail-load` resolving `true`). Test in Task 5.
3. A password appearing in a trace via an error message that echoes script source. Test in Task 1.
4. Agent told "signed in" when it was not. Test in Task 6.
5. Agent told "asleep" when the Mac was online but busy or the report was lost. Test in Task 7.

---

### Task 1: Trace recorder, failure codes, attempt wrapper

**Files:**

- Create: `apps/desktop/src/failure-codes.mjs`, `apps/desktop/src/trace.mjs`
- Test: `apps/desktop/src/trace.test.mjs`

**Interfaces — Produces:**

- `CODES: Record<string, string>` — code → default sentence for the agent.
- `class Failure extends Error { code: string; detail: object }` — `new Failure(code, message?, detail?)`; unknown code throws at construction (closed list).
- `note(name: string, detail?: object): void` — appends a step to the current attempt; no-op outside one.
- `secret(value: string): void` — registers a string to redact in the current attempt.
- `setCapture(fn: () => Promise<string|null>): void` — screenshot source for the current attempt.
- `attempt({kind, requestId?, portalId?, target?}, fn) → Promise<{ ok: true, value, record } | { ok: false, code, message, record }>`
- `record: { id, kind, requestId, portalId, target, startedAt, endedAt, outcome, code, message, error?: {name, message, stack}, steps: {t, name, detail}[], screenshot? }`
- `onRecord(sink: (record) => void)` — registers where finished records go (Task 3 adds local file + upload).

Codes (closed list):

```
nav.invalid_url nav.dns nav.offline nav.connection nav.cert nav.timeout nav.blocked nav.failed
page.no_page_open page.element_gone page.element_covered page.not_editable page.read_only
page.not_select page.no_option page.bad_key page.bad_scroll page.no_history page.needs_ref
page.needs_text page.unknown_action page.script_failed page.not_signin_page
signin.no_credentials signin.keychain_unavailable signin.keychain_declined signin.rejected
signin.second_factor signin.stuck signin.timeout signin.no_way_in
sync.not_linked sync.unknown_site sync.needs_login sync.push_failed sync.device_unlinked
transport.report_failed
internal.unexpected internal.no_outcome
```

- [ ] Write `trace.test.mjs`: (a) `attempt` returning normally → `ok:true`, record has `outcome:'ok'`, ordered steps with `t` ≥ 0; (b) `fn` throws `Failure('nav.dns', 'x')` → `ok:false, code:'nav.dns', message:'x'`; (c) throws plain `Error('boom')` → `code:'internal.unexpected'`, `message` is the _default sentence_ (not "boom"), `record.error.message === 'boom'`, stack present; (d) `new Failure('nope')` throws; (e) `secret('hunter2')` then `note('x', {msg:'pw hunter2 here'})` and a thrown `Error('script hunter2')` → no `hunter2` anywhere in `JSON.stringify(record)`; (f) `note('typed', {text:'abc'})` records `{text:'[3 chars]'}` (keys `text|password|value` are length-only); (g) `note` outside an attempt does nothing and does not throw; (h) nested `attempt` inside an attempt is refused with `internal.unexpected` naming nesting; (i) `setCapture` is called only on failure and its result lands in `record.screenshot`; a capture that throws records a step `capture.failed` and the outcome is unchanged; (j) a sink that throws does not change the returned outcome and the error is written to `console.error`.
- [ ] Run `pnpm vitest run apps/desktop/src/trace.test.mjs` → fails (module missing).
- [ ] Implement `failure-codes.mjs` (object literal, each code → one sentence the agent can repeat to a student) and `trace.mjs` (AsyncLocalStorage store `{record, secrets:Set, capture}`; `redact()` walks strings replacing each secret; `attempt()` uses try/catch/finally: finally sets `endedAt`, and if neither ok nor failed was set records `internal.no_outcome`).
- [ ] Run the test → passes.
- [ ] Commit: `Diagnostics: a trace recorder, a closed list of failure codes, and one outcome per attempt.`

### Task 2: ESLint rule — no unexplained catch in the desktop app

**Files:**

- Create: `eslint-rules/explained-catch.js`, `eslint-rules/explained-catch.test.mjs` (vitest include gets `eslint-rules/*.test.mjs`)
- Modify: `eslint.config.js` (register local plugin for `apps/desktop/src/**/*.mjs`, excluding tests), `vitest.config.ts` include list

**Rule:** a `CatchClause` body, or the function passed to `.catch(...)`, is explained when it contains (anywhere inside) a `throw`, a call to `note`/`fail`/`logEvent`, or begins with a comment `// expected: <reason>` / `/* expected: ... */`. Anything else is an error: "Explain this catch: record it with note()/logEvent(), rethrow, or mark it `// expected: why this is normal`."

- [ ] Tests with `RuleTester`: valid — `try{}catch(e){note('x')}`, `try{}catch{throw e}`, `try{}catch{ // expected: not a URL\n return false }`, `p.catch((e)=>logEvent('a',e))`; invalid — `try{}catch{}`, `try{}catch{ /* gone */ }`, `p.catch(()=>{})`, `p.catch(()=>null)`.
- [ ] Run → fails. Implement rule. Run → passes.
- [ ] Register it; run `pnpm lint` and **record the count of violations** (expected ≈45). They are fixed in Tasks 4–6; lint must be clean by the end of Task 6.
- [ ] Commit: `Diagnostics: a lint rule that refuses an unexplained catch in the desktop app.`

### Task 3: Local trace log, outbox, upload; server table and endpoints

**Files:**

- Create: `apps/desktop/src/trace-store.mjs`, test `trace-store.test.mjs`
- Modify: `apps/desktop/src/sync.mjs` (add `uploadAttempt`, `heartbeat`)
- Create: `packages/db/src/schema/` additions in `devices.ts` (`browserAttempts` table; `devices.state jsonb`, `devices.stateAt`; `siteRefreshRequests.pickedUpAt`), migration `0021_browser_attempts.sql` via `pnpm db:generate`
- Modify: `apps/api/src/routes/devices.ts` (`POST /attempts`, `POST /heartbeat`, set `pickedUpAt` in `GET /pending`)
- Test: `apps/api/src/routes/devices.integration.test.ts` (new cases)

**Interfaces — Produces:**

- `trace-store.mjs`: `logDir()`, `writeLocal(record)` (append JSONL, sync, mode 0600 dir 0700), `logEvent(code, message, detail?)` (app-level event line, `kind:'event'`), `queueUpload(record)`, `flushOutbox(send: (record)=>Promise)` — outbox is `<logDir>/outbox/<id>.json`; a send that fails leaves the file; success deletes it.
- `sync.mjs`: `uploadAttempt(creds, record)` → `POST /api/devices/attempts`; `heartbeat(creds, state)` → `POST /api/devices/heartbeat` with `{busy: null | {kind, portalId?, since}, version}`.
- Table `browser_attempts`: `id uuid pk` (desktop-generated, insert ignores duplicates), `user_id`, `device_id`, `request_id uuid null`, `kind text`, `portal_id text null`, `target text null`, `outcome text`, `code text null`, `message text null`, `error jsonb null`, `steps jsonb`, `screenshot text null`, `started_at`, `ended_at`, `created_at`; indexes `(user_id, created_at)`, `(code, created_at)`. Insert also deletes rows older than 14 days for that user.

- [ ] Desktop tests (`CONTEXTO_LOG_DIR` = temp dir): writeLocal appends one line per record to today's file; queueUpload + flushOutbox with a failing send keeps the file, with a succeeding send removes it; a record containing a screenshot is written locally _without_ the screenshot (local log stays small) but uploaded with it.
- [ ] API tests: device posts an attempt → row stored scoped to its user; posting the same id twice stores one row; body over 2 MB is refused; `GET /pending` sets `picked_up_at`; heartbeat updates `devices.state`/`state_at`; another student's device cannot post with a foreign `request_id` (request_id dropped to null unless it belongs to the same user).
- [ ] Run → fail. Implement schema, `pnpm db:generate`, routes, desktop store. Run `pnpm db:migrate` against the test DB and the tests → pass.
- [ ] Commit: `Diagnostics: traces are written on the Mac first, then sent; the server keeps them.`

### Task 4: Wrap every desktop entry point in an attempt; fix transport swallowing

**Files:** Modify `apps/desktop/src/main.mjs`, `apps/desktop/src/operations.mjs`, `apps/desktop/src/sync.mjs`; tests in `operations.test.mjs`, new `work-loop.test.mjs` (extract `runWorkItem(item, deps)` from `doPendingWork` into `apps/desktop/src/work.mjs` so it is testable without Electron).

**Interfaces — Produces:** `work.mjs`: `runWorkItem(item, {browsePage, actOnPage, syncPortal}) → {outcome, result, record}` where `result` on failure is `{code, reason, attemptId}`; `reportWithRetry(send, args, {tries:3, delays:[1000,3000]})`.

Fixes (each catch either records, rethrows, or gets `// expected:`):

- `main.mjs:423` → `runWorkItem`: every failure reports `{code, reason}`; non-`Failure` errors report `internal.unexpected` with the default sentence (raw message stays in the trace).
- `main.mjs:430` → `reportWithRetry`; final failure → `logEvent('transport.report_failed', …)` and the record keeps the step.
- `main.mjs:401` → `pendingWork` failure: `logEvent` on state _change_ only (online→offline, linked→unlinked), not every 3 s.
- `main.mjs:289-291` (`firstSignIn`), `:364` (`syncAll`), `:275`, `:602` (`refreshSession`) → `attempt`/`logEvent`.
- `main.mjs:79/631` → heartbeat every 10 s **outside** the `drivingBrowser` gate, carrying what the gate is busy with (`oneAtATime` gains `current()` returning `{kind, portalId, since} | null`).
- `operations.mjs` `autoSignIn`, `runSync`, `browsePage`, `actOnPage` → run inside `attempt`; `autoSignIn`'s blanket "could not be completed" replaced by the coded failure (password safe because `readCredentials` result is passed to `secret()`); dropped `recovered.reason` now noted; `browser.close().catch(()=>{})` → `.catch((e) => note('close.failed', {error: e.message}))`.
- `sync.mjs:202` `sessionValid` offline → still returns true, `logEvent('transport.offline')`.

- [ ] Tests: `runWorkItem` with a browse that throws `Failure('nav.dns')` → `{outcome:'failed', result:{code:'nav.dns', reason, attemptId}}`; with a plain Error → `internal.unexpected`, reason is the default sentence, never the raw message; with a sync whose `needsLogin` → `needs_login` plus `code:'sync.needs_login'`; `reportWithRetry` retries then succeeds; gives up after 3 and calls `logEvent`; `oneAtATime().current()` reflects the running pass.
- [ ] Run → fail; implement; run → pass; `pnpm lint` shows fewer violations.
- [ ] Commit: `Diagnostics: every piece of work ends in a coded outcome, and reports are retried.`

### Task 5: Navigation and page actions report what actually happened

**Files:** Modify `apps/desktop/src/site-session.mjs`, `apps/desktop/src/page-actions.mjs`, `apps/desktop/src/explorer.mjs`, `apps/desktop/src/browser.mjs`, `apps/desktop/src/cdp.mjs`, `apps/desktop/src/chrome.mjs`, `apps/desktop/src/recorder.mjs`; tests in their `*.test.mjs`.

- `ActionError` becomes `class ActionError extends Failure` with signature `(code, message)`; every `throw new ActionError(msg)` gets its `page.*` code.
- `SiteSession.navigate` → resolves `{ok:true, url, status}` on `did-finish-load`; on main-frame `did-fail-load` maps Chromium net error codes: `-105`→`nav.dns`, `-106`→`nav.offline`, `-100..-199` other→`nav.connection`, `-200..-299`→`nav.cert`, `-20/-21/-301`→`nav.blocked`, `-3` (ABORTED, a replaced navigation) is noted and waiting continues, anything else→`nav.failed` with the code and description in detail; timeout → `{ok:false, timedOut:true, url}` (noted, not thrown — the page may still be readable). `loadURL().catch` records the error instead of discarding it. HTTP status from `did-navigate` recorded.
- `browsePage` notes `nav.timeout` and still snapshots; only throws when the snapshot itself fails (`page.script_failed`). Fixed 2.5 s sleep replaced by `settle`'s load wait, plus a note of how long it took.
- `page-actions.mjs`: `click` — the `CLICK_CHECK` catch notes `click.check_failed_navigating` (still success); `drawn` capture failure noted; `submitStep` swallowed covered errors noted per try; `movedOn` evaluate error noted; `settle`/`loaded` timeout noted with the URL.
- `explorer.mjs`: `looksLikeLogin` returns `{login:boolean, why:'off_origin'|'password_field'}`; body/parse failure records `why`.
- `cdp.mjs`: `send` gets a 30 s timeout → `Failure('nav.timeout', …)`; unparseable frame is noted and dropped instead of crashing.
- Remaining CLI-path catches in `browser.mjs`, `chrome.mjs`, `recorder.mjs`, `credentials.mjs`, `sync.mjs:39,114`, `operations.mjs:227,240,287`, `main.mjs:145,486` → `// expected:` comments where they are genuinely normal (URL parse, file absent), records otherwise.
- `credentials.mjs` `readCredentials` distinguishes: exit code 44 (item not found) → `null`; exit 51/128 (user cancelled / interaction not allowed) → throws `Failure('signin.keychain_declined')`; `security` missing → `signin.keychain_unavailable`.

- [ ] Tests (fake `webContents` emitter like existing tests): `did-fail-load(-105)` → `nav.dns`; `-3` then `did-finish-load` → ok; timeout → `timedOut:true` and a `nav.timeout` step; `ActionError` instances carry codes (update existing assertions); `readCredentials` with a stubbed `execFileSync` exiting 44 → null, 51 → `keychain_declined`; `cdp.send` with no reply → rejects `nav.timeout` after the (injected, short) timeout.
- [ ] Run → fail; implement; run → pass. `pnpm lint` → only sign-in catches left.
- [ ] Commit: `Diagnostics: a failed page load is a failure, with the reason Chromium gave.`

### Task 6: Sign-in returns a verified result

**Files:** Modify `apps/desktop/src/page-actions.mjs` (`signInFromKeychain`, `type`, `performAction`), `apps/desktop/src/sign-in.mjs` (`explainFailure` → codes); tests in `page-actions.test.mjs`, `sign-in.test.mjs`.

**Interfaces — Produces:** `signInFromKeychain(...) → {status: 'signed_in'|'second_factor', steps:number}`; every other ending throws a `Failure`:

- step 0 `none` and no Google button → `page.not_signin_page`
- no credentials and no Google button → `signin.no_credentials` (step 0) / `signin.no_way_in` (later step: notes the origin that had none)
- same `origin|state` after a fill and Google already tried → `signin.rejected`, detail includes the page's visible error text near the form (first 200 chars of `[role=alert], .error, [aria-live]` — page words go to the trace only; agent gets the default sentence + "the site showed an error")
- loop ends on step limit → `signin.stuck` with last `state` and origin; deadline → `signin.timeout`
- `signInScript` returning `'no-sign-in-field'` → `signin.stuck`
- `second-factor` → `{status:'second_factor'}` (not a failure: the student acts)
- `none` after a fill → **verified** `signed_in` only if origin is not `accounts.google.com`; on Google with `none` → `signin.stuck` (Google page we do not understand).
  `performAction` for `sign_in` returns the snapshot plus `signIn: {status}`.

- [ ] Tests (existing fake session pattern in `page-actions.test.mjs`): each ending above produces its code; a sign-in whose page never changes after fill → `signin.rejected`, not success; a run ending with no login field on the site → `signed_in`; second factor → `second_factor`; the password never appears in the record (assert on `JSON.stringify(record)`).
- [ ] Run → fail; implement; run → pass. `pnpm lint` → **zero** explained-catch violations in `apps/desktop/src`.
- [ ] Commit: `Diagnostics: sign-in says how it ended, and only says signed in when it checked.`

### Task 7: The agent hears the real reason

**Files:** Modify `apps/api/src/portal-snapshots.ts` (`awaitRefresh` classification), `packages/agent/src/tools/types.ts` (return type), `packages/agent/src/tools/browser.ts`, `packages/agent/src/tools/portal.ts`; tests `apps/api/src/portal-snapshots.integration.test.ts`, `packages/agent/src/tools/browser.test.ts`, `portal.test.ts` (existing or new).

**Interfaces:** `awaitRefresh(requestId, timeoutMs) → {finished:true, outcome} | {finished:false, why:{code, message}}` with server codes:

- `transport.offline` — device not seen for > 30 s ("last seen N minutes ago")
- `transport.busy` — device seen, `state.busy` set ("busy syncing <portal> since …")
- `transport.no_report` — `picked_up_at` set, never completed ("started at … and never reported back")
- `transport.not_picked_up` — device seen and idle, request never collected (a bug; worded as such)
- `transport.no_device` — no linked device.

Tool changes:

- `browser_open` failure: reads `resultOf` and uses `{code, reason}`; never the generic "could not load it" when a reason exists.
- `browser_act` `sign_in`: note built from `signIn.status` — `signed_in` → "signed in (checked)"; `second_factor` → "the site is asking for a second step only the student can do; ask them to finish it in the browser card, then call look". Failures quote the reason.
- `portal_refresh` `needs_login`: says whether a saved sign-in existed and what failed (from `result.code`).
- All `!waited.finished` branches use `why.message` instead of `ASLEEP`.

- [ ] Tests: `awaitRefresh` returns each `why.code` for the corresponding DB state (device lastSeenAt old; busy state; picked up but incomplete; idle and not picked up); `browser_act` with `outcome:'read'` and `signIn.status:'second_factor'` does not say "Done: you signed in"; `browser_open` failure with `{code:'nav.dns', reason}` includes the reason; timeout notes include the classification message.
- [ ] Run → fail; implement; run → pass.
- [ ] Commit: `Diagnostics: the agent is told why, not "their computer is asleep".`

### Task 8: Developer debug page and `pnpm trace`

**Files:**

- Modify: `apps/api/src/env.ts` (`DEVELOPER_EMAILS` optional, comma list), `apps/api/src/routes/index.ts` (mount `/debug`, add `developer:boolean` to `/me`), `packages/shared/src/agent.ts` (`MeProfile.developer?: boolean`)
- Create: `apps/api/src/middleware/developer.ts`, `apps/api/src/routes/debug.ts`, test `debug.integration.test.ts`
- Create: `apps/web/src/screens/Debug.tsx`, route `debug` / `debugAttempt` in `apps/web/src/lib/router.ts`, render in `App.tsx`, styles in `index.css`
- Create: `scripts/trace.mjs`, root script `"trace": "node scripts/trace.mjs"`

**Interfaces:** `GET /api/debug/attempts?failed=1&code=&email=&limit=50` → `[{id, email, kind, portalId, target, outcome, code, message, startedAt, durationMs, hasScreenshot}]`; `GET /api/debug/attempts/:id` → full record + `email` + linked request `{kind, outcome, requestedAt, pickedUpAt, completedAt}`. Both 404 (not 403) for non-developers, so the route's existence is not advertised.

`pnpm trace` → latest 20 failed attempts (one line each); `pnpm trace <id>` → full timeline + saves screenshot to scratch and prints its path; `pnpm trace --local` reads today's local JSONL instead (works offline). Auth: the desktop config's `sessionToken` and `apiBase` (`~/Library/Application Support/ContextoAgent/config.json`), overridable with `CONTEXTO_SESSION` / `CONTEXTO_API`.

- [ ] API tests: non-developer → 404 on both; developer sees attempts from all users with emails; `failed=1` filters; `/me` has `developer:true` only for listed emails (case-insensitive, trimmed).
- [ ] Web: `Debug.tsx` list (failed toggle, code filter) and detail (step timeline with `+ms`, error block, screenshot `<img>`). A smoke test renders list and detail from a stubbed fetch.
- [ ] Run tests → pass. Run `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] Commit: `Diagnostics: a debug page and pnpm trace for developers.`

### Task 9: Feasibility probe for Part 2 (throwaway)

**Files:** `apps/desktop/native/probe/main.swift` (throwaway; deleted or replaced in Part 2)

Questions, each answered with evidence on this Mac against the wearelcc.ca profile window:

1. With `AXManualAccessibility=true` set on Chrome's app element, does the web area of a page expose roles/labels/positions to our process?
2. Does `AXPress` activate an ordinary link and button?
3. Does setting `AXValue` on a React-controlled input register with the page (value survives blur / form submit)?
4. Can an AppleScript window id + active tab be matched to the AX window reliably (title + bounds)?
5. Does `open -na "Google Chrome" --args --profile-directory="Profile 1" --new-window <url>` open in the running Chrome's school profile?

- [ ] Write the probe; run it (macOS will prompt for Accessibility/Automation — the user approves once).
- [ ] Report each answer to the user with the evidence, then write Part 2's plan from the results.
