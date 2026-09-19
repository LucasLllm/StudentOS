/**
 * Packaging config.
 *
 * A JavaScript config rather than a block in package.json for one reason:
 * notarization has to be conditional. Setting `notarize: true` unconditionally
 * fails the build on any machine without Apple credentials -- including CI,
 * and including a contributor who just wants to check the app still launches.
 * Here it switches itself on only when the credentials actually exist.
 */

// App Store Connect API key (preferred), or the older Apple ID + app-specific
// password. Either set is enough; electron-builder reads them from the
// environment itself, so nothing secret is ever written into this file.
const hasApiKey = Boolean(
  process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER,
);
const hasAppleId = Boolean(
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID,
);
const canNotarize = hasApiKey || hasAppleId;

if (!canNotarize) {
  console.log(
    '[desktop] No Apple credentials — building unsigned.\n' +
      '[desktop] Runs here. On any other Mac the student must approve it once in\n' +
      '[desktop] System Settings > Privacy & Security. See README, "Installing it".',
  );
}

const { execFileSync } = require('node:child_process');
const { rmSync } = require('node:fs');
const { join } = require('node:path');

/**
 * Ad-hoc sign the bundle when there is no real identity.
 *
 * Left alone, the app keeps only the linker's signature: identifier
 * "Electron", no resource seal. macOS calls a quarantined copy of that
 * DAMAGED -- a dead end offering nothing but "Move to Trash". Ad-hoc signing
 * produces a consistent signature under the right bundle id, which downgrades
 * it to the ordinary "unidentified developer" refusal a student can get past
 * in System Settings.
 *
 * Not a substitute for a Developer ID. It is the difference between a wall
 * and a door with a warning on it.
 *
 * electron-builder cannot do this itself -- it treats identity "-" as a
 * keychain name to look up and skips signing when it finds none -- so it
 * happens here, after packing and before the DMG is built.
 */
function adHocSign(context) {
  if (canNotarize) return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // --deep is deprecated for real identities but remains the practical way to
  // seal an Electron bundle's many nested helpers with an ad-hoc signature.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log('[desktop] ad-hoc signed', appPath);
}

/**
 * Leave only the DMG behind.
 *
 * The DMG is built from an unpacked copy of the app, and left where it was
 * that copy is a real, launchable application sitting inside the repo.
 * Spotlight indexes it, Launchpad lists it beside the installed one, and
 * opening "ContextoAgent" from either can start it instead -- so a developer
 * ends up with two apps, and the one running is not the one they installed.
 * Measured, more than once. The installed copy is the one to run; this is
 * what makes it the only one.
 */
function dropUnpackedApp() {
  rmSync(join(__dirname, 'release', 'mac-arm64'), { recursive: true, force: true });
  console.log('[desktop] removed the unpacked app; install from the DMG in release/');
}

module.exports = {
  afterPack: adHocSign,
  afterAllArtifactBuild: dropUnpackedApp,
  appId: 'ai.contextoagent.desktop',
  productName: 'ContextoAgent',
  directories: { output: 'release', buildResources: 'build' },
  // Ship source only. The Chrome this drives is the student's own install,
  // not a bundled copy, which keeps the download to Electron alone.
  files: ['src/**/*', '!src/**/*.test.mjs', 'package.json'],
  mac: {
    category: 'public.app-category.education',
    // Apple Silicon only for now. Adding 'x64' back builds an Intel DMG too,
    // at the cost of a second ~110MB download and a second unpacked app that
    // is easy to launch by mistake -- they are indistinguishable in Spotlight.
    target: [{ target: 'dmg', arch: ['arm64'] }],
    // The hardened runtime exists to satisfy notarization, and it constrains
    // what V8 may do. Enabling it on a build that is not being notarized adds
    // the constraints and buys nothing.
    hardenedRuntime: canNotarize,
    ...(canNotarize
      ? {
          entitlements: 'build/entitlements.mac.plist',
          entitlementsInherit: 'build/entitlements.mac.plist',
        }
      : {}),
    notarize: canNotarize,
  },
};
