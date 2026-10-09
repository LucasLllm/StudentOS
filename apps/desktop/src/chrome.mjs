import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Finding a browser to drive.
 *
 * We drive the student's real, installed Chrome rather than embedding one.
 * That is not a packaging convenience -- it is the only thing that works.
 * Google refuses OAuth from embedded user-agents with `disallowed_useragent`,
 * so a browser rendered inside our own app could never complete a "Sign in
 * with Google" flow, which is how most school portals authenticate. A real
 * Chrome is a real browser and is treated as one.
 *
 * Order is deliberate: Chrome first because it is what school SSO is tested
 * against, then Edge because it is preinstalled on every Windows machine,
 * then the rest. All are Chromium, so all speak the same protocol.
 */
const CANDIDATES = {
  darwin: [
    ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['chrome', join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')],
    ['edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ['brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    ['chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  ],
  win32: [
    [
      'chrome',
      join(
        process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
        'Google\\Chrome\\Application\\chrome.exe',
      ),
    ],
    [
      'chrome',
      join(
        process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
        'Google\\Chrome\\Application\\chrome.exe',
      ),
    ],
    ['chrome', join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe')],
    [
      'edge',
      join(
        process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
        'Microsoft\\Edge\\Application\\msedge.exe',
      ),
    ],
    [
      'brave',
      join(
        process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
        'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      ),
    ],
  ],
  linux: [],
};

// Linux installs land wherever the distro puts them, so ask PATH instead of guessing.
const LINUX_BINARIES = [
  ['chrome', 'google-chrome'],
  ['chrome', 'google-chrome-stable'],
  ['edge', 'microsoft-edge'],
  ['brave', 'brave-browser'],
  ['chromium', 'chromium'],
  ['chromium', 'chromium-browser'],
];

function isExecutable(path) {
  if (!path) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    // expected: not there, or not executable -- the next candidate is tried.
    return false;
  }
}

function whichSync(binary) {
  try {
    return execFileSync('which', [binary], { encoding: 'utf8' }).trim() || null;
  } catch {
    // expected: `which` exits non-zero when the binary is not on PATH.
    return null;
  }
}

/**
 * @returns {{ brand: string, path: string }}
 * @throws when no Chromium-family browser is installed.
 *
 * The two ways of looking are injectable so this can be asked about a machine
 * other than the one running it. Without that the only honest test is "is
 * Chrome installed here", which tests the machine rather than the order of
 * preference, and red-lines CI on any runner without a browser.
 */
export function findBrowser(
  platform = process.platform,
  { executable = isExecutable, which = whichSync } = {},
) {
  for (const [brand, path] of CANDIDATES[platform] ?? []) {
    if (executable(path)) return { brand, path };
  }

  if (platform === 'linux') {
    for (const [brand, binary] of LINUX_BINARIES) {
      const resolved = which(binary);
      if (resolved && executable(resolved)) return { brand, path: resolved };
    }
  }

  throw new Error(
    'No Chromium-based browser found. Contexto drives Google Chrome (or Edge, ' +
      'or Brave) to read your school portal. Install Chrome and try again.',
  );
}
