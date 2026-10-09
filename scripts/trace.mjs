#!/usr/bin/env node
/**
 * Read browser traces from the terminal.
 *
 *   pnpm trace                 the latest 20 failed attempts, one line each
 *   pnpm trace --all           the latest 20 attempts, failed or not
 *   pnpm trace --code X        only attempts that failed with code X
 *   pnpm trace <id>            one attempt in full; its screenshot is saved to a file
 *   pnpm trace --local         today's traces on this Mac, from the local log --
 *                              works offline, and shows the app's own events too
 *
 * Talks to the API as whoever this Mac's Contexto Agent app is signed in as,
 * which has to be an account listed in DEVELOPER_EMAILS on that server.
 * CONTEXTO_API and CONTEXTO_SESSION override the app's config.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter(
  (a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--code'),
);

const red = (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

function config() {
  const dir =
    process.env['CONTEXTO_CONFIG_DIR'] ||
    join(homedir(), 'Library', 'Application Support', 'ContextoAgent');
  try {
    return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function get(path) {
  const c = config();
  const base = process.env['CONTEXTO_API'] || c.apiBase || 'https://contextoagent.ai';
  const token = process.env['CONTEXTO_SESSION'] || c.sessionToken;
  if (!token) {
    console.error('No session: link the Contexto Agent app on this Mac, or set CONTEXTO_SESSION.');
    process.exit(1);
  }
  const res = await fetch(new URL(path, base), { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) {
    console.error(
      `${base} answered 404. Either the attempt does not exist, or the account this Mac is ` +
        'signed in as is not in DEVELOPER_EMAILS on that server.',
    );
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`${base} answered ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

function line(a) {
  const when = new Date(a.startedAt ?? a.at).toLocaleString();
  const code = a.code ?? 'ok';
  const what = [a.kind, a.portalId ?? a.target ?? ''].join(' ').trim();
  const secs = a.durationMs !== undefined ? `${(a.durationMs / 1000).toFixed(1)}s` : '';
  const head = `${dim(when)}  ${a.outcome === 'failed' ? red(code) : code}  ${what}  ${dim(secs)}`;
  return `${head}${a.email ? dim(`  ${a.email}`) : ''}${a.id ? dim(`  ${a.id}`) : ''}${
    a.message ? `\n    ${a.message}` : ''
  }`;
}

function full(a) {
  console.log(line(a));
  if (a.request) {
    const r = a.request;
    console.log(
      dim(
        `  request ${r.kind}: asked ${r.requestedAt}, collected ${r.pickedUpAt ?? 'never'}, ` +
          `reported ${r.completedAt ?? 'never'} as ${r.outcome ?? '-'}`,
      ),
    );
  }
  console.log('\n  steps:');
  for (const s of a.steps ?? []) {
    console.log(`  ${dim(`+${String(s.t).padStart(6)}ms`)}  ${s.name}`);
    if (s.detail !== undefined) console.log(`             ${dim(JSON.stringify(s.detail))}`);
  }
  if (a.detail) console.log(`\n  detail: ${JSON.stringify(a.detail, null, 2)}`);
  if (a.error) console.log(`\n  error: ${a.error.name}: ${a.error.message}\n${a.error.stack}`);
  if (a.screenshot) {
    const out = join(tmpdir(), `contexto-trace-${a.id}.jpg`);
    writeFileSync(out, Buffer.from(a.screenshot.split(',')[1] ?? '', 'base64'));
    console.log(`\n  screenshot: ${out}`);
  }
}

if (flag('--local')) {
  const dir =
    process.env['CONTEXTO_LOG_DIR'] ||
    join(homedir(), 'Library', 'Logs', 'ContextoAgent', 'traces');
  const days = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  const day = days.at(-1);
  if (!day) {
    console.log(`No traces in ${dir}.`);
    process.exit(0);
  }
  const rows = readFileSync(join(dir, day), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const id = positional[0];
  if (id) {
    const one = rows.find((r) => r.id === id);
    if (!one) {
      console.error(`No attempt ${id} in ${day}.`);
      process.exit(1);
    }
    full(one);
  } else {
    console.log(dim(`${join(dir, day)}\n`));
    for (const r of rows.slice(-40)) {
      if (r.kind === 'event')
        console.log(`${dim(new Date(r.at).toLocaleString())}  ${r.code}  ${r.message}`);
      else console.log(line({ ...r, durationMs: Date.parse(r.endedAt) - Date.parse(r.startedAt) }));
    }
  }
} else if (positional[0]) {
  full(await get(`/api/debug/attempts/${encodeURIComponent(positional[0])}`));
} else {
  const query = new URLSearchParams({ limit: '20' });
  if (!flag('--all')) query.set('failed', '1');
  if (option('--code')) query.set('code', option('--code'));
  const rows = await get(`/api/debug/attempts?${query}`);
  if (rows.length === 0) console.log('Nothing recorded.');
  for (const r of rows) console.log(line(r));
}
