# The school profile lives in the app

The agent's browser becomes one persistent profile, the way a Chrome profile is: sign in to a site once and it stays signed in, and Sign in with Google carries from one site to the next. When a page asks for a sign-in, the student's computer types the saved username and password. After every step the conversation shows a picture of the page.

Two complaints drove this. The agent reached a sign-in form, typed the username, and refused the password, so the student had to be signed in already for anything to work. And the student wanted the agent in their real Chrome, in the wearelcc.ca profile, where every school session already exists.

The real Chrome is out of reach. Since Chrome 136 no outside process may attach to the profile the student actually uses; the one door left is an extension installed in that profile, which is how Claude in Chrome works. The wearelcc.ca profile is managed by the school and cannot take an extension. Copying the profile to a second Chrome was rejected: it is 1.5 GB, its policies come with it, and it already uses Chrome's device-bound sessions, so copied Google cookies may refuse to refresh. So the profile the student wants is built inside the app instead.

## One profile

Every browser the app opens shares one persistent partition, `persist:school`, whatever site it is for. Today each connected site has its own partition and everything else uses a throwaway one, which is why a Google session could never carry across. `SiteSession` keeps `portalId` as the label the conversation card shows and the explorer works by; the partition is a constant.

In `browsePage`, the same conversation gets the same view whatever site the address is on, the way following a link does in a tab. The label is the connected site's id when the address belongs to one, and the page's host otherwise.

The Studyo sync and `autoSignIn` open the same partition, so the keychain sign-in lands in the shared profile. Studyo's existing session is lost by the move and comes back on the next sync, through the recovery that already runs when a site has no session and a saved sign-in. The old partitions stay on disk unused.

## A browser Google accepts

The view identifies itself as Electron, and Google's sign-in page refuses that outright. The shared session gets a plain Chrome user agent: Electron's own fallback with the `Electron/x.y.z` and `ContextoAgent/x.y.z` tokens removed, set once when the partition's session is first taken. `userAgentFor(fallback)` is a pure function so the stripping is testable.

The debugger stays attached for the life of the view, as now. An in-process attach does not set `navigator.webdriver`; the spike confirms it by evaluating it in the view.

This is the one thing that cannot be known from the code, so it is measured first, before the rest is built. The student opens the browser card and signs in to the wearelcc.ca Google account by hand. Pass: Google lets them through to the account. Fail: Google says the browser or app may not be secure, in which case the work stops and the decision comes back to the student, because the only route left is the profile copy this document rejects.

## Signing in, typed by the machine

`browser_act` gains an action, `sign_in`, which takes no element number. On the student's computer it:

1. Reads the page's origin and finds the connected site whose sign-in address or origin matches it exactly, then reads that site's username and password from the keychain. No match: it fails with a reason the agent can pass on, that there is no saved sign-in for that host, that the student can sign in once in the browser card and it stays signed in, or save one under Settings, Connections, Sites.
2. Reads the page and fills what it asks for. A password box present: the username goes into the box before it, or the email or text box in the same form, and the password into the password box. No password box but an email or username box: only that is filled, which is how Google asks for the address first and the password on the next page. Neither: it fails saying the page is not asking for a sign-in.
3. Types by the same path as `type`: focus by a real click, select all, insert the text, then press Enter. It waits for the page to settle and returns the reading, so the agent sees where the sign-in landed.

`type` into a password box no longer refuses. It does what `sign_in` does, and the agent's text is discarded, never typed. Password boxes still never report what they hold.

The two guarantees behind the old refusal stay true. The agent never receives a password: the keychain is read on the student's computer, at the moment of typing, and the value goes into the page and nowhere else. A saved password can only go to the origin it was saved for: exact origin, not a host suffix, so no page can talk the agent into typing it somewhere else.

Google itself has no saved sign-in in this build. The first Google sign-in is by hand in the card, because school accounts have two-step verification and a typed password alone cannot finish it. After that the profile holds the session and Google is not asked again. A saved Google sign-in that the machine types up to the two-step prompt is a follow-up.

## A picture after every step

After every `browsePage` and `actOnPage`, once the page has settled and been read, the computer takes a screenshot of the view over the debugger, `Page.captureScreenshot` as JPEG at half scale, under a short timeout so a capture that hangs costs nothing but the picture. `operations.mjs` hands the frame to the app through the same observer that reports a session opening and closing; `main.mjs` sends it to the window as a `site-frame` event carrying the agent id, label, title, address and the image as a data URL, and keeps the last one so `siteSession` can answer with it on mount. The bridge exposes `onSiteFrame`. The collapsed card shows the latest frame under its title bar; Open still raises the live view. Frames never leave the machine.

Chromium will not composite what is not on screen, and a view made invisible yields no frames: this was measured when the earlier streaming attempt was built and is why it needed an offscreen window. So the view is no longer hidden between steps. Collapsed, it is parked: visible, sized to a laptop viewport of 1280 by 800 so the agent reads and the picture shows a normal layout, and placed so that at most one pixel column lies inside the window. Expanded, its bounds follow the card as now. The spike measures that a parked view still produces a picture; if a view entirely outside the window does not, the one-pixel edge is the fallback, and if neither does, the card shows only frames taken while it was open and the decision comes back to the student.

## The prompt and the tool

The browser skill's sign-in section is rewritten. When a page asks for a sign-in, use `sign_in`: their computer types the saved sign-in for that site and returns the page. A site with no saved sign-in: say so, and that they can sign in once in the browser card and it stays signed in, or save one in Settings. Google: the first time they sign in by hand in the card; after that it stays signed in. Never say you cannot log in. The claim that Google sites cannot be connected goes. The `browser_act` description says the same in fewer words, and its schema, `BrowserAction` and `describeAction` learn `sign_in`. The API carries an action to the computer without inspecting it, so nothing changes there. The universal sign-in section in `run.ts` says there is no manual sign-in to send them to; that stops being true, and it says instead that for a site behind Google they sign in once in the browser card.

The Sites settings copy stops saying a saved sign-in cannot get past Google and says instead that for a site behind Google you sign in once in the browser card.

## Order of work and files

First the spike, on this Mac: shared partition, user agent, parked bounds and the screenshot capture, then the two measurements. Then the rest.

Desktop: `site-session.mjs`, `operations.mjs`, `page-actions.mjs`, `sign-in.mjs`, `main.mjs`, `web-preload.cjs`. Web: `lib/desktop.ts`, `lib/useAgentSession.ts`, `screens/AgentSession.tsx`, `screens/SiteConnections.tsx`. Agent: `tools/browser.ts`, `tools/types.ts`, `prompts/browser.md`, `run.ts`.

## Testing

Unit tests come before each piece. Desktop: `sign_in` fills username and password and presses Enter when both boxes are present, fills only the address box when there is no password box, and fails on a page with no sign-in form; `type` into a password box never types the agent's text; a password box still reports no value; `userAgentFor` strips the Electron and app tokens and nothing else; the site matcher matches an exact origin and not a suffix; a frame is offered after a browse and after an action. Web: the card shows the latest frame when collapsed; the hook takes a frame from the session reply and from the event. Agent: `sign_in` is accepted without a number, is described in words, and appears in the tool description; the skill says to use it, says Google is once by hand, and no longer says Google sites cannot be connected.

Then on this Mac: the Google spike, and the agent asked to open Studyo from a signed-out state and getting in on its own.

## Not in this build

Real Chrome tabs. A saved Google sign-in. Live video in the card. Removing the old per-site partitions from disk.
