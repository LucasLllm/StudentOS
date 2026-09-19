# Contexto Agent desktop companion

Reads school portals that have no API — Veracross, Mozaïk — using logins the
student completes themselves, and pushes what it finds to their account.

## Why it exists

Classroom has an API. Veracross does not, and it sits behind school SSO. The
only place a student's coursework is reachable is a browser they have already
logged into, so this drives one.

It does **not** embed a browser. Google refuses OAuth from embedded webviews,
so a student at a Workspace school could never complete SSO inside our own
window. This drives the real Chrome they already have.

## Running it

```sh
pnpm install
pnpm --filter @contexto/desktop start     # the app window
pnpm --filter @contexto/desktop dist      # build a DMG into release/
```

Point it at a local API with `CONTEXTO_API` and `CONTEXTO_WEB`.

## Command line

The same operations, without the window. Useful for writing portal support.

```sh
pnpm --filter @contexto/desktop link
pnpm --filter @contexto/desktop sync    veracross "https://portals.veracross.com/lcc/student"
pnpm --filter @contexto/desktop explore veracross "<url>" --budget 20
pnpm --filter @contexto/desktop record  veracross "<url>"
```

`record` and `explore` write **shapes** by default — field names and types, no
values — because their output is a spec a human reads. `sync` writes real
values, because it feeds the student's own agent, which cannot answer "what is
due Friday" from `string<date>`.

## Two things worth knowing before changing this

**Login and reading are separate browser launches.** Measured on Chrome 151,
`--remote-debugging-pipe` sets `navigator.webdriver = true` while
`--remote-debugging-port` leaves it false — but the port is an unauthenticated
TCP listener any local process can use to drive an authenticated school portal.
So login runs with _no_ debugging transport at all, and only afterwards does
drive mode reopen the same profile over the pipe. See the header of
`src/browser.mjs`.

**The origin lock and page budget are enforced in code, not in a prompt.** A
model talked into wandering must still be unable to. See `src/explorer.mjs`.

Since Chrome 136 refuses debugging on the default profile, this physically
cannot reach the Chrome holding the student's Gmail and Drive.

## Installing it (unsigned)

This ships unsigned. Signing for distribution needs a paid Apple Developer
membership -- a free Apple account only issues development certificates, which
Gatekeeper does not accept on anyone else's Mac -- so every student approves
the app by hand, once.

Since macOS 15 the old right-click -> Open shortcut no longer works. The route
is System Settings, and it is worth writing out for whoever you send this to:

1. Open the DMG and drag **ContextoAgent** to Applications.
2. Open it. macOS refuses, saying Apple cannot check it for malicious
   software. Click **Done** -- not "Move to Trash".
3. Open **System Settings > Privacy & Security**, scroll to **Security**.
   There is a line saying ContextoAgent was blocked. Click **Open Anyway**.
4. Authenticate, then click **Open Anyway** once more.

It is asked once per install, not every launch.

### If it says "damaged and cannot be opened"

That is a different message and there is no Open Anyway on it. It means the
bundle's signature is inconsistent, which is what an unsigned Electron app
looks like once it carries a download's quarantine flag: the linker's own
signature, identifier "Electron", no resource seal.

The build ad-hoc signs the bundle for exactly this reason -- see `adHocSign`
in the builder config -- which turns that dead end into the ordinary refusal
above. If you meet it anyway on an older download:

```sh
xattr -dr com.apple.quarantine /Applications/ContextoAgent.app
```

Building it yourself avoids all of this: an app built locally never gets the
quarantine flag that triggers the check, so `pnpm --filter @contexto/desktop
dist` and installing from the DMG in `release/` just works. The build keeps
only the DMG. An unpacked app left in the repo is a second application as far
as Spotlight and Launchpad are concerned, and the one that ends up running.

### If you do enrol later

Set these and the same command signs and notarizes -- the config switches
itself on when it finds them, and stays quiet when it does not:

```sh
export APPLE_API_KEY=~/private_keys/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
pnpm --filter @contexto/desktop dist
spctl -a -vvv -t install /Applications/ContextoAgent.app   # once installed; expect "accepted"
```

The certificate must be **Developer ID Application**. "Apple Distribution" is
for the App Store and produces a build macOS still refuses.

## Known issues

**Electron's own postinstall fails silently on Node 24.** `extract-zip` opens
the first archive entry and exits 0, leaving no binary; the download itself is
fine and its checksum validates. `scripts/ensure-electron.mjs` runs after
install and extracts from the archive Electron already downloaded. If you see
"Electron failed to install correctly", run `pnpm install` again.
