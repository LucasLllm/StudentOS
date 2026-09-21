/**
 * Filling in a sign-in form, wherever it is being filled in.
 *
 * One implementation so the browser the student watches and any other path
 * cannot drift into signing in differently -- a difference that would show up
 * as "it worked when I tested it" and nowhere else.
 */

/**
 * The one script, with a choice of strictness.
 *
 * Strict wants the whole form and reports what is missing: that is a saved
 * sign-in being tried against a site's own sign-in page, where "no password
 * box" means the address was wrong. Loose fills whichever step the page is
 * on: the address alone, the password alone, or both -- which is how Google
 * and its like ask, one page at a time.
 *
 * @returns {string} JavaScript to evaluate in the page.
 */
function script(username, password, { wholeForm }) {
  return `(() => {
    // Assigning .value is invisible to React, which tracks its own state, so
    // the form would submit empty. Going through the prototype setter and
    // firing the events is what a real keystroke looks like.
    const set = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter ? setter.call(el, value) : (el.value = value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const go = (form) => {
      const submit = form.querySelector('button[type=submit], input[type=submit]')
        ?? Array.from(form.querySelectorAll('button')).find((b) => !b.type || b.type === 'submit');
      if (submit) submit.click();
      else if (form.requestSubmit) form.requestSubmit();
      else if (form.submit) form.submit();
    };
    const usable = (i) => /^(text|email|tel)$/.test(i.type) && !i.disabled;
    const pw = document.querySelector('input[type=password]');
    if (pw) {
      const form = pw.form ?? document;
      const inputs = Array.from(form.querySelectorAll('input'));
      const before = inputs.slice(0, inputs.indexOf(pw)).reverse();
      const user = before.find(usable)
        ?? Array.from(form.querySelectorAll('input[type=email], input[type=text]')).find(usable);
      if (!user && ${wholeForm}) return 'no-username-field';
      if (user) set(user, ${JSON.stringify(username)});
      set(pw, ${JSON.stringify(password)});
      go(form);
      return 'submitted';
    }
    if (${wholeForm}) return 'no-password-field';
    // Nothing but a password box is ever given the password. A page with only
    // an address box gets the address, which is Google's first step.
    const user = Array.from(document.querySelectorAll('input')).find(usable);
    if (!user) return 'no-sign-in-field';
    set(user, ${JSON.stringify(username)});
    go(user.form ?? document);
    return 'submitted-username';
  })()`;
}

/**
 * Build the expression that types a saved sign-in into a site's own form,
 * and says what is missing when the form is not there.
 *
 * @returns {string} JavaScript to evaluate in the page.
 */
export function fillScript(username, password) {
  return script(username, password, { wholeForm: true });
}

/**
 * Build the expression that fills whichever sign-in step the page is showing.
 *
 * @returns {string} JavaScript to evaluate in the page; it resolves to
 *   'submitted', 'submitted-username' or 'no-sign-in-field'.
 */
export function signInScript(username, password) {
  return script(username, password, { wholeForm: false });
}

/** Whether the page is still asking to be signed in, and where it ended up. */
export const INSPECT_SCRIPT = `JSON.stringify({
  stillAsking: Boolean(document.querySelector('input[type=password]')),
  landed: location.href
})`;

/** What went wrong, in words a student can act on. */
export function explainFailure(code) {
  return (
    {
      'no-password-field': 'that address has no sign-in form on it',
      'no-username-field': 'the sign-in form there has no username box this could fill',
      'no-sign-in-field': 'the page is not asking for a sign-in',
    }[code] ?? 'the sign-in form could not be filled in'
  );
}
