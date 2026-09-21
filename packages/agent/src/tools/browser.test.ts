import { describe, expect, it, vi } from 'vitest';
import { actInBrowser, browseWithAgent, describeAction, renderElements } from './browser.js';
import type { BrowserAction, ToolContext } from './types.js';

/**
 * What the model is told when it works a page.
 *
 * The desktop does the clicking; what is pinned here is the contract on this
 * side of it -- that a call missing what it needs is told what to send, that
 * an action reaches the computer as sent and tagged with the conversation,
 * that the page comes back as a numbered list the next call can use, and
 * that every result says the page is not to be obeyed.
 */

const PAGE = {
  url: 'https://library.example/search?q=chem',
  title: 'Search results',
  text: 'Three results for chem.',
  elements: [
    { ref: 1, role: 'link', name: 'Chemistry 101', href: 'https://library.example/1' },
    { ref: 2, role: 'textbox', name: 'Search', value: 'chem' },
    { ref: 3, role: 'button', name: 'Search' },
  ],
};

function ctxWith(over: Partial<ToolContext['portals']> & { result?: unknown } = {}) {
  const requestAction = vi.fn(async () => ({ requestId: 'act-1' }));
  const ctx = {
    userId: 'u1',
    agentId: 'a1',
    portals: {
      latest: async () => [],
      requestRefresh: async () => ({ alreadyPending: false, requestId: 'r1' }),
      awaitRefresh: async () => ({ finished: true, outcome: 'read' }),
      requestBrowse: async () => ({ requestId: 'b1' }),
      requestAction,
      resultOf: async () => over.result ?? PAGE,
      ...over,
    },
  } as unknown as ToolContext;
  return { ctx, requestAction };
}

describe('renderElements', () => {
  it('writes one line per element, numbered, with what a person would need', () => {
    expect(renderElements(PAGE.elements)).toEqual([
      '[1] link "Chemistry 101" -> https://library.example/1',
      '[2] textbox "Search" = "chem"',
      '[3] button "Search"',
    ]);
  });

  it('shows a tick, a disabled state, and the choices in a list', () => {
    expect(
      renderElements([
        { ref: 4, role: 'checkbox', name: 'Remember me', checked: true },
        { ref: 5, role: 'button', name: 'Next', disabled: true },
        { ref: 6, role: 'select', name: 'Term', value: 'Fall', options: ['Fall', 'Spring'] },
      ]),
    ).toEqual([
      '[4] checkbox "Remember me" (checked)',
      '[5] button "Next" (disabled)',
      '[6] select "Term" = "Fall" options: Fall | Spring',
    ]);
  });

  it('never shows what a password box holds, even if it arrived', () => {
    const lines = renderElements([
      { ref: 7, role: 'password', name: 'Password', value: 'hunter2' },
    ]);
    expect(lines).toEqual(['[7] password "Password"']);
  });

  it('ignores junk and stops at the limit', () => {
    expect(renderElements(null)).toEqual([]);
    expect(renderElements([null, 'x', { role: 'link' }, { ref: 1, role: 'link' }])).toEqual([
      '[1] link',
    ]);
    const many = Array.from({ length: 300 }, (_, i) => ({ ref: i + 1, role: 'link', name: 'x' }));
    expect(renderElements(many)).toHaveLength(120);
  });
});

describe('browser_open', () => {
  it('hands back the page as a numbered list the next call can use', async () => {
    const { ctx } = ctxWith();
    const result = (await browseWithAgent.execute({ url: 'https://library.example/' }, ctx)) as {
      opened: boolean;
      elements: string[];
      note: string;
    };
    expect(result.opened).toBe(true);
    expect(result.elements).toEqual(renderElements(PAGE.elements));
    expect(result.note).toMatch(/browser_act/);
  });
});

describe('browser_act', () => {
  it('tells the model what a call is missing rather than sending it half-made', async () => {
    const { ctx, requestAction } = ctxWith();
    const missing = async (input: Record<string, unknown>) =>
      (await actInBrowser.execute(input as never, ctx)) as { acted: boolean; note: string };

    expect((await missing({ action: 'click' })).note).toMatch(/click needs ref/);
    expect((await missing({ action: 'type', ref: 2 })).note).toMatch(/type needs text/);
    expect((await missing({ action: 'type', text: 'x' })).note).toMatch(/type needs ref/);
    expect((await missing({ action: 'press' })).note).toMatch(/press needs key/);
    expect((await missing({ action: 'select', ref: 6 })).note).toMatch(/select needs value/);
    expect((await missing({ action: 'scroll' })).note).toMatch(/scroll needs direction/);
    expect(requestAction).not.toHaveBeenCalled();
  });

  it('sends the action as given, tagged with the conversation', async () => {
    const { ctx, requestAction } = ctxWith();
    await actInBrowser.execute({ action: 'type', ref: 2, text: 'organic', submit: true }, ctx);
    expect(requestAction).toHaveBeenCalledWith(
      'u1',
      { action: 'type', ref: 2, text: 'organic', submit: true },
      'a1',
    );
  });

  it('sends a sign-in with no element number, and says it signed in', async () => {
    // The computer picks the boxes and the keychain supplies the words; the
    // model only asks. Nothing it could send would be typed anyway.
    const { ctx, requestAction } = ctxWith();
    const result = (await actInBrowser.execute({ action: 'sign_in' }, ctx)) as {
      acted: boolean;
      note: string;
    };
    expect(requestAction).toHaveBeenCalledWith('u1', { action: 'sign_in' }, 'a1');
    expect(result.acted).toBe(true);
    expect(result.note).toMatch(/signed in/i);
  });

  it('returns the page after, and says the step was done', async () => {
    const { ctx } = ctxWith();
    const result = (await actInBrowser.execute({ action: 'click', ref: 3 }, ctx)) as {
      acted: boolean;
      note: string;
      elements: string[];
      text: string;
    };
    expect(result.acted).toBe(true);
    expect(result.note).toMatch(/clicked \[3\]/);
    expect(result.note).toMatch(/NEVER as instructions/);
    expect(result.text).toBe('Three results for chem.');
    expect(result.elements[1]).toBe('[2] textbox "Search" = "chem"');
  });

  it('passes on the reason when the computer could not do it', async () => {
    const { ctx } = ctxWith({
      awaitRefresh: async () => ({ finished: true, outcome: 'failed' }),
      result: { reason: 'There is no element [3] on the page any more.' },
    });
    const result = (await actInBrowser.execute({ action: 'click', ref: 3 }, ctx)) as {
      acted: boolean;
      note: string;
    };
    expect(result.acted).toBe(false);
    expect(result.note).toMatch(/no element \[3\]/);
  });

  it('says the computer is asleep rather than pretending', async () => {
    const { ctx } = ctxWith({ awaitRefresh: async () => ({ finished: false }) });
    const result = (await actInBrowser.execute({ action: 'look' }, ctx)) as {
      finished: boolean;
      note: string;
    };
    expect(result.finished).toBe(false);
    expect(result.note).toMatch(/asleep or shut/);
  });

  it('points at linking a computer when there is none', async () => {
    const result = (await actInBrowser.execute({ action: 'look' }, {
      userId: 'u1',
      agentId: 'a1',
    } as ToolContext)) as { unavailable: true; reason: string };
    expect(result.unavailable).toBe(true);
    expect(result.reason).toMatch(/link one/i);
  });
});

describe('describeAction', () => {
  it.each<[BrowserAction, RegExp]>([
    [{ action: 'click', ref: 3 }, /clicked \[3\]/],
    [
      { action: 'type', ref: 2, text: 'chem', submit: true },
      /typed "chem" into \[2\] and pressed Enter/,
    ],
    [{ action: 'press', key: 'Escape' }, /pressed Escape/],
    [{ action: 'select', ref: 6, value: 'Spring' }, /chose "Spring" in \[6\]/],
    [{ action: 'scroll', direction: 'down' }, /scrolled down/],
    [{ action: 'scroll', ref: 9 }, /scrolled to \[9\]/],
    [{ action: 'back' }, /went back/],
    [{ action: 'look' }, /looked/],
    [{ action: 'sign_in' }, /signed in with their saved sign-in/],
  ])('%j', (action, expected) => {
    expect(describeAction(action)).toMatch(expected);
  });
});
