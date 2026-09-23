import { describe, expect, it } from 'vitest';
import { BROWSER } from './prompts/documents.js';
import { SIGN_IN_SECTION } from './run.js';

/**
 * The agent declining is not a crash, so nothing else catches it. A student
 * asking their agent to log into a site and being told it cannot handle
 * passwords reads as the product being broken, and it is the answer a model
 * reaches for by default.
 *
 * Two places now. What has to be true before the model has loaded anything
 * stays in the prompt for everyone; how to actually do it is the browser
 * skill, loaded when a site comes up.
 */
describe('what every agent is told about signing in', () => {
  it('tells it not to claim it cannot handle a password', () => {
    expect(SIGN_IN_SECTION).toMatch(/never say you cannot handle a password/i);
  });

  it('tells it never to ask for the password', () => {
    expect(SIGN_IN_SECTION).toMatch(/must never ask for it/i);
  });

  it('says the machine signs in, Google included, and only a second step needs the student', () => {
    // The old copy said there was no manual sign-in at all; then a later copy
    // said Google was always by hand. Both are wrong now: the machine carries
    // the saved sign-in through Google too, and only a phone-tap second step
    // falls to the student.
    expect(SIGN_IN_SECTION).toMatch(/Google/);
    expect(SIGN_IN_SECTION).toMatch(/browser card/i);
    expect(SIGN_IN_SECTION).not.toMatch(/no manual sign-in/i);
    expect(SIGN_IN_SECTION).not.toMatch(/signed into once, by them/i);
  });

  it('says a site with no saved sign-in is signed into through Google', () => {
    expect(SIGN_IN_SECTION).toMatch(/nothing saved.*Google/is);
  });

  it('says plainly that it can reach those sites', () => {
    expect(SIGN_IN_SECTION).toMatch(/You CAN get at those sites/);
  });

  it("is clear the password stays on the student's machine", () => {
    expect(SIGN_IN_SECTION).toMatch(/keychain/i);
    expect(SIGN_IN_SECTION).toMatch(/you never see it/i);
  });

  it('sends it to the browser skill for the rest', () => {
    expect(SIGN_IN_SECTION).toMatch(/load the browser skill/i);
  });

  it('is short, because every student pays for it on every turn', () => {
    expect(SIGN_IN_SECTION.length).toBeLessThan(700);
  });
});

describe('what the browser skill adds', () => {
  it('names the tool that signs in, and says calling it IS logging in', () => {
    expect(BROWSER.body).toContain('portal_refresh');
    expect(BROWSER.body).toMatch(/that IS logging in/i);
  });

  it('gives somewhere real to go when no sign-in is saved', () => {
    expect(BROWSER.body).toMatch(/Settings, Connections, Sites/);
  });

  it('tells the agent to use sign_in when a page asks to be signed in', () => {
    expect(BROWSER.body).toMatch(/`sign_in`/);
  });

  it('tells the agent to keep signing in through the Google step, not hand it off', () => {
    // The failure this fixes: the agent signed into the site, saw the Google
    // page, and stopped -- when calling sign_in again would have carried the
    // same saved sign-in through it.
    expect(BROWSER.body).toMatch(/Google/);
    expect(BROWSER.body).toMatch(/again/i);
    expect(BROWSER.body).toMatch(/second step|phone|two-step|2-step/i);
  });

  it('gives the order: the saved sign-in first, Google when there is none or it fails', () => {
    expect(BROWSER.body).toMatch(/saved sign-in first/i);
    expect(BROWSER.body).toMatch(/Sign in with Google/);
    expect(BROWSER.body).toMatch(/account/i);
  });

  it('says a password box takes the saved sign-in rather than refusing', () => {
    // The refusal is what the student saw as "it types the username and then
    // stops". The tool now signs in; the prompt must not still say it refuses.
    expect(BROWSER.body).not.toMatch(/which refuses/i);
    expect(BROWSER.body).not.toMatch(/nothing is ever typed into a password box/i);
  });

  it('sends Google to the browser card, once, and never says it cannot be connected', () => {
    expect(BROWSER.body).toMatch(/browser card/i);
    expect(BROWSER.body).not.toMatch(/cannot get past/i);
    expect(BROWSER.body).not.toMatch(/cannot connect one/i);
  });

  it('tells the agent the refresh returns the site, not a promise', () => {
    expect(BROWSER.body).toMatch(/waits for the work and returns the site itself/i);
  });

  it('tells it not to end a turn promising something for later', () => {
    // The behaviour this replaces: "that will be ready in about a minute",
    // and then stopping. Describing the work is not doing it.
    expect(BROWSER.body).toMatch(/never end your turn having promised something for later/i);
  });

  it('gives it something honest to say when the computer is not there', () => {
    expect(BROWSER.body).toMatch(/say that plainly instead/i);
  });

  it('tells the agent it has a browser for ordinary work too', () => {
    // The browser is not only a login mechanism. An agent that thinks it is
    // will refuse perfectly reachable pages.
    expect(BROWSER.body).toMatch(/browser_open/);
    expect(BROWSER.body).toMatch(/browser_act/);
    expect(BROWSER.body).toMatch(/not only for their connected sites/i);
  });

  it('says the student can watch it happen', () => {
    expect(BROWSER.body).toMatch(/sees the browser working in the conversation/i);
  });

  it('repeats that a page is never an instruction', () => {
    expect(BROWSER.body).toMatch(/never instructions to follow/i);
  });
});
