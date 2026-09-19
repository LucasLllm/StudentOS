import { describe, expect, it } from 'vitest';
import {
  activityKey,
  BASIC_PHRASES,
  NICHE_PHRASES,
  NICHE_SHARE,
  THEMES,
  pickPhrase,
  phrasesFor,
  themeFor,
} from './thinkingPhrases.js';
import type { Theme } from './thinkingPhrases.js';

/** Predictable stand-in for Math.random: hands back the given values in turn. */
const rolls = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
};

/**
 * A small deterministic generator, so the distribution test means the same
 * thing on every run. A flaky assertion about randomness is worse than none:
 * it gets muted, and then the weighting can drift unnoticed.
 */
const lcg = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

describe('reading the theme off what the agent is doing', () => {
  it('calls waiting on the model reasoning', () => {
    expect(themeFor({ kind: 'thinking' })).toBe('reasoning');
  });

  it('calls no activity at all reasoning', () => {
    // The poll has not come back yet, or this build of the server does not
    // report steps. Either way the line still has to say something.
    expect(themeFor(undefined)).toBe('reasoning');
  });

  it.each([
    ['google_classroom_list_coursework', 'coursework'],
    ['google_classroom_turn_in', 'writing'],
    ['google_drive_read_file', 'files'],
    ['gmail_search', 'mail'],
    ['gmail_send_message', 'writing'],
    ['web_read_link', 'reading'],
    ['youtube_video_details', 'reading'],
    ['portal_read', 'browsing'],
    ['browser_open', 'browsing'],
    ['browser_act', 'browsing'],
    ['vault_write', 'writing'],
  ])('reads %s as %s', (name, theme) => {
    expect(themeFor({ kind: 'tool', name })).toBe(theme);
  });

  it('calls reading a skill reading', () => {
    expect(themeFor({ kind: 'skill', name: 'browser' })).toBe('reading');
  });

  it('falls back to reasoning for a tool it has never heard of', () => {
    // A tool added to the agent and not to this table must not blank the line.
    expect(themeFor({ kind: 'tool', name: 'quantum_homework_solver' })).toBe('reasoning');
  });
});

describe('the phrase lists', () => {
  it('ends every phrase with an ellipsis, and only one', () => {
    for (const phrase of [...BASIC_PHRASES, ...NICHE_PHRASES]) {
      expect(phrase.text).toMatch(/[^.…]…$/);
    }
  });

  it('has no phrase twice', () => {
    const all = [...BASIC_PHRASES, ...NICHE_PHRASES].map((p) => p.text);
    expect(new Set(all).size).toBe(all.length);
  });

  it('leaves every theme enough to say', () => {
    // Too few and a long turn on one kind of work repeats itself, which reads
    // as the app being stuck on a loop rather than working.
    for (const theme of THEMES) {
      expect(phrasesFor(theme, BASIC_PHRASES).length).toBeGreaterThanOrEqual(6);
      expect(phrasesFor(theme, NICHE_PHRASES).length).toBeGreaterThanOrEqual(4);
    }
  });

  it('keeps the general-purpose phrases available to every theme', () => {
    for (const theme of THEMES) {
      expect(phrasesFor(theme, BASIC_PHRASES).map((p) => p.text)).toContain('Thinking…');
    }
  });
});

describe('picking one', () => {
  const themeOf = (text: string): readonly Theme[] | 'any' => {
    const phrase = [...BASIC_PHRASES, ...NICHE_PHRASES].find((p) => p.text === text);
    if (!phrase) throw new Error(`picked a phrase that is on no list: ${text}`);
    return phrase.themes;
  };

  it('only ever picks a phrase that fits the work', () => {
    const activity = { kind: 'tool', name: 'gmail_search' } as const;
    for (let i = 0; i < 200; i += 1) {
      const themes = themeOf(pickPhrase(activity));
      expect(themes === 'any' || themes.includes('mail')).toBe(true);
    }
  });

  it('takes a basic phrase just below the niche share', () => {
    const text = pickPhrase({ kind: 'thinking' }, { random: rolls(NICHE_SHARE + 0.01, 0) });
    expect(BASIC_PHRASES.map((p) => p.text)).toContain(text);
  });

  it('takes a niche phrase just below the boundary', () => {
    const text = pickPhrase({ kind: 'thinking' }, { random: rolls(NICHE_SHARE - 0.01, 0) });
    expect(NICHE_PHRASES.map((p) => p.text)).toContain(text);
  });

  it('keeps the niche ones rare over a long run', () => {
    const random = lcg(42);
    const niche = new Set(NICHE_PHRASES.map((p) => p.text));
    let rare = 0;
    const runs = 4000;
    for (let i = 0; i < runs; i += 1) {
      if (niche.has(pickPhrase({ kind: 'thinking' }, { random }))) rare += 1;
    }
    expect(rare / runs).toBeGreaterThan(NICHE_SHARE - 0.05);
    expect(rare / runs).toBeLessThan(NICHE_SHARE + 0.05);
  });

  it('does not repeat what was just on screen', () => {
    const activity = { kind: 'thinking' } as const;
    const first = pickPhrase(activity);
    for (let i = 0; i < 200; i += 1) {
      expect(pickPhrase(activity, { avoid: [first] })).not.toBe(first);
    }
  });

  it('still says something when everything that fits was just used', () => {
    // Better a repeat than a blank line. A turn long enough to exhaust a
    // theme has to keep reporting.
    const activity = { kind: 'tool', name: 'gmail_search' } as const;
    const everything = [...BASIC_PHRASES, ...NICHE_PHRASES].map((p) => p.text);
    expect(pickPhrase(activity, { avoid: everything })).not.toBe('');
  });

  it('avoids repeats across registers, not just within one', () => {
    // The avoid list holds whatever was last shown, and the previous phrase
    // could have come from either list.
    const niche = NICHE_PHRASES[0]?.text ?? '';
    for (let i = 0; i < 200; i += 1) {
      expect(pickPhrase({ kind: 'thinking' }, { avoid: [niche] })).not.toBe(niche);
    }
  });
});

/**
 * Telling a new step from the same step reported again.
 *
 * The poll hands back a freshly built object every few seconds, so comparing
 * activities by identity says "changed" on every tick and the line churns
 * through words while the agent has not moved. Comparing by what they say is
 * what makes the phrase hold still through one step and turn over at the next.
 */
describe('recognising the same step twice', () => {
  it('gives one name to a conversation with nothing running', () => {
    expect(activityKey(undefined)).toBe(activityKey(undefined));
  });

  it('reads two reports of the same tool as the same step', () => {
    expect(activityKey({ kind: 'tool', name: 'gmail_search' })).toBe(
      activityKey({ kind: 'tool', name: 'gmail_search' }),
    );
  });

  it('separates one tool from another', () => {
    expect(activityKey({ kind: 'tool', name: 'gmail_search' })).not.toBe(
      activityKey({ kind: 'tool', name: 'google_drive_list_files' }),
    );
  });

  it('separates thinking from running a tool', () => {
    expect(activityKey({ kind: 'thinking' })).not.toBe(
      activityKey({ kind: 'tool', name: 'gmail_search' }),
    );
  });

  it('separates thinking from having nothing to report', () => {
    // One is a turn waiting on the model; the other is a server that does not
    // report steps at all. They deserve different words.
    expect(activityKey({ kind: 'thinking' })).not.toBe(activityKey(undefined));
  });

  it('reads two reports of the same skill as the same step', () => {
    expect(activityKey({ kind: 'skill', name: 'browser' })).toBe(
      activityKey({ kind: 'skill', name: 'browser' }),
    );
  });

  it('separates one skill from another', () => {
    expect(activityKey({ kind: 'skill', name: 'browser' })).not.toBe(
      activityKey({ kind: 'skill', name: 'vault-reading' }),
    );
  });

  it('separates reading a skill from running a tool of the same name', () => {
    expect(activityKey({ kind: 'skill', name: 'browser' })).not.toBe(
      activityKey({ kind: 'tool', name: 'browser' }),
    );
  });

  it('cannot be spoofed by a tool named after another kind', () => {
    expect(activityKey({ kind: 'tool', name: 'thinking' })).not.toBe(
      activityKey({ kind: 'thinking' }),
    );
  });
});
