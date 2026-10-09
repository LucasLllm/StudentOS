import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CODES } from './failure-codes.mjs';

/**
 * The list of failure codes is only worth anything if it is the whole truth:
 * every code the app can produce is on it, every code on it can actually be
 * produced, and every one has a test that produces it. A code nobody tests is
 * a diagnosis nobody has seen work.
 */

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.mjs'));
const source = files
  .filter((f) => !f.endsWith('.test.mjs') && f !== 'failure-codes.mjs')
  .map((f) => readFileSync(join(here, f), 'utf8'))
  .join('\n');
const tests = files
  .filter((f) => f.endsWith('.test.mjs') && f !== 'failure-codes.test.mjs')
  .map((f) => readFileSync(join(here, f), 'utf8'))
  .join('\n');

/** Every quoted string in the source that looks like a code. */
const mentioned = (text) =>
  new Set([...text.matchAll(/['"`]([a-z]+\.[a-z_]+)['"`]/g)].map((m) => m[1]));

describe('failure codes', () => {
  const inSource = mentioned(source);
  const inTests = mentioned(tests);
  const families = new Set(Object.keys(CODES).map((c) => c.split('.')[0]));

  it('are all produced somewhere in the app', () => {
    const unused = Object.keys(CODES).filter((code) => !inSource.has(code));
    expect(unused).toEqual([]);
  });

  it('are all exercised by a test', () => {
    const untested = Object.keys(CODES).filter((code) => !inTests.has(code));
    expect(untested).toEqual([]);
  });

  it('include every code the app throws', () => {
    const thrown = [...source.matchAll(/new (?:Failure|ActionError)\(\s*['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    expect(thrown.length).toBeGreaterThan(10);
    expect(thrown.filter((code) => !Object.hasOwn(CODES, code))).toEqual([]);
  });

  it('include every code the app logs, apart from the one recovery event', () => {
    const logged = [...source.matchAll(/logEvent\(\s*(?:\n\s*)?['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    expect(logged.length).toBeGreaterThan(3);
    const events = new Set(['transport.online']);
    expect(logged.filter((code) => !Object.hasOwn(CODES, code) && !events.has(code))).toEqual([]);
  });
});
