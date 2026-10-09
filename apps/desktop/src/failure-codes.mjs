/**
 * Every way a piece of browser work can fail, and what to say when it does.
 *
 * A closed list. A failure that fits none of these is internal.unexpected,
 * which is a bug report rather than an answer: the fix is a new code here and
 * a test that produces it, so the next student gets told what happened.
 *
 * The sentence is what the agent hears when nothing more specific was said.
 * It is written by this app, never taken from a page, so it is safe to pass
 * on -- the page's own words go to the trace and nowhere else.
 */
export const CODES = Object.freeze({
  'nav.invalid_url': 'That is not an address the browser can open.',
  'nav.dns': 'That address does not exist: its name could not be found.',
  'nav.offline': 'The computer is not connected to the internet.',
  'nav.connection': 'The site could not be reached: the connection was refused or dropped.',
  'nav.cert': "The site's security certificate was not valid, so the browser refused it.",
  'nav.timeout': 'The page took too long to load.',
  'nav.blocked': 'The page was blocked before it loaded.',
  'nav.failed': 'The page failed to load.',

  'page.no_page_open':
    'There is no page open in this conversation. Open one with browser_open first.',
  'page.element_gone':
    'That element is no longer on the page -- it has changed since it was read. Look again.',
  'page.element_covered':
    'That element is behind something else on the page, so the click did not reach it.',
  'page.not_editable': 'That element is not something that can be typed into.',
  'page.read_only': 'That element does not accept typing right now.',
  'page.not_select': 'That element is not a drop-down list.',
  'page.no_option': 'That drop-down list has no matching option.',
  'page.bad_key': 'That is not a key this browser can press.',
  'page.bad_scroll': 'Scroll needs a direction or an element.',
  'page.no_history': 'There is no earlier page to go back to.',
  'page.needs_ref': 'That action needs the number of an element from the page.',
  'page.needs_text': 'That action needs the text or option to use.',
  'page.unknown_action': 'That is not something this browser can do.',
  'page.script_failed': 'The page could not be read.',
  'page.not_signin_page': 'This page is not asking for a sign-in.',

  'signin.no_credentials':
    'There is no saved sign-in for this site and no "Sign in with Google" button to press.',
  'signin.keychain_unavailable': "This computer's keychain is not available.",
  'signin.keychain_declined':
    'The keychain did not hand over the saved sign-in -- the request was declined or blocked.',
  'signin.rejected': 'The site did not accept the saved sign-in.',
  'signin.second_factor': 'The site is asking for a second step only the student can complete.',
  'signin.stuck': 'The sign-in reached a step it does not know how to complete.',
  'signin.timeout': 'The sign-in took too long and was stopped.',
  'signin.no_way_in': 'The sign-in reached a page the saved sign-in does not belong to.',

  'sync.not_linked': 'This computer is not linked to an account.',
  'sync.unknown_site': 'There is no connected site by that name on this computer.',
  'sync.needs_login': 'The site needs signing into again.',
  'sync.push_failed': 'The site was read, but what was found could not be sent.',
  'sync.device_unlinked': 'This computer was unlinked from the account.',

  'transport.report_failed': 'The work finished, but its result could not be sent back.',

  'internal.unexpected': 'Something went wrong on their computer that it has no explanation for.',
  'internal.no_outcome': 'The work ended without saying whether it worked.',
});
