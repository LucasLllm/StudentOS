// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { fillScript, signInScript } from './sign-in.mjs';

/**
 * One filler, two callers. autoSignIn wants a whole form and says so when it
 * is not there; the agent's sign_in fills whatever step the page is on --
 * Google asks for the address first and the password on the next page. Both
 * go through the same script, so they cannot drift.
 */

// Indirect, so the script sees the page's globals and not this module's.
const run = (script) => (0, eval)(script);

/** A form that records a submit instead of navigating away. */
function form(inner) {
  document.body.innerHTML = `<form>${inner}<button type="submit">Go</button></form>`;
  const submitted = { count: 0 };
  document.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitted.count += 1;
  });
  return submitted;
}

describe('signInScript', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('fills username and password and submits', () => {
    const submitted = form(`<input type="text" name="u"><input type="password" name="p">`);
    expect(run(signInScript('alice', 'hunter2'))).toBe('submitted');
    expect(document.querySelector('input[type=text]').value).toBe('alice');
    expect(document.querySelector('input[type=password]').value).toBe('hunter2');
    expect(submitted.count).toBe(1);
  });

  it('fills only the address on a page that asks for that first', () => {
    const submitted = form(`<input type="email" name="identifier">`);
    expect(run(signInScript('alice@example.com', 'hunter2'))).toBe('submitted-username');
    expect(document.querySelector('input[type=email]').value).toBe('alice@example.com');
    expect(submitted.count).toBe(1);
  });

  it('fills only the password on a page that asks for that alone', () => {
    const submitted = form(`<input type="password" name="p">`);
    expect(run(signInScript('alice', 'hunter2'))).toBe('submitted');
    expect(document.querySelector('input[type=password]').value).toBe('hunter2');
    expect(submitted.count).toBe(1);
  });

  it('says so on a page with no sign-in on it', () => {
    document.body.innerHTML = `<p>Nothing to sign into here.</p>`;
    expect(run(signInScript('alice', 'hunter2'))).toBe('no-sign-in-field');
  });

  it('never puts the password anywhere but a password box', () => {
    form(`<input type="email" name="identifier">`);
    run(signInScript('alice@example.com', 'hunter2'));
    expect(document.body.innerHTML).not.toContain('hunter2');
    expect(document.querySelector('input[type=email]').value).not.toBe('hunter2');
  });
});

describe('fillScript keeps asking for the whole form', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('still reports a page with no password box', () => {
    form(`<input type="email" name="identifier">`);
    expect(run(fillScript('alice', 'hunter2'))).toBe('no-password-field');
  });

  it('still reports a form with no username box', () => {
    form(`<input type="password" name="p">`);
    expect(run(fillScript('alice', 'hunter2'))).toBe('no-username-field');
  });

  it('fills and submits a whole form', () => {
    const submitted = form(`<input type="text" name="u"><input type="password" name="p">`);
    expect(run(fillScript('alice', 'hunter2'))).toBe('submitted');
    expect(submitted.count).toBe(1);
  });
});
