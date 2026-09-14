import type { AgentActivity } from '@contexto/shared';

/**
 * What the line under a question says while the agent works.
 *
 * A turn that reads a student's mail, opens their portal and then thinks about
 * both can run for a minute. One frozen word across all of it reads as a hang,
 * and a word picked at random reads as noise -- so the phrase is drawn from
 * the ones that fit the step the agent is actually on, and it changes when
 * that step does.
 *
 * Pure on purpose: no clock, no React, and the randomness is injectable, so
 * the weighting and the fit are things a test can actually pin down.
 */

/**
 * The kinds of work worth distinguishing.
 *
 * Coarser than the tool list deliberately. A student does not care whether it
 * listed coursework or listed topics; they care that it is in their classes.
 */
export const THEMES = [
  'reasoning',
  'coursework',
  'files',
  'mail',
  'reading',
  'browsing',
  'writing',
] as const;
export type Theme = (typeof THEMES)[number];

export interface Phrase {
  /** Shown as written, ellipsis included. */
  text: string;
  /** `any` for the phrases that fit whatever the agent happens to be doing. */
  themes: readonly Theme[] | 'any';
}

/**
 * Tools that change something rather than read it.
 *
 * Split out by name because the prefix cannot tell them apart -- sending mail
 * and searching it are both `gmail_`, and only one of them is the agent
 * writing on the student's behalf.
 */
const WRITING_TOOLS = new Set([
  'google_classroom_turn_in',
  'google_classroom_unsubmit',
  'google_classroom_attach_file',
  'gmail_send_message',
  'gmail_modify_message',
  'gmail_trash_message',
  'vault_write',
]);

/**
 * Everything else, by prefix.
 *
 * By prefix rather than by exact id so a tool added to the agent tomorrow
 * lands somewhere sensible without anyone remembering to come back here. The
 * cost of getting it wrong is a slightly off-theme word, which is why this is
 * allowed to guess at all.
 */
const THEME_PREFIXES: readonly (readonly [string, Theme])[] = [
  ['google_classroom_', 'coursework'],
  ['google_drive_', 'files'],
  ['gmail_', 'mail'],
  ['web_read_', 'reading'],
  ['youtube_', 'reading'],
  ['portal_', 'browsing'],
  ['browser_', 'browsing'],
];

/**
 * A name for the step, so the same step reported twice compares equal.
 *
 * The poll builds a fresh object every few seconds. Comparing those by
 * identity says the agent moved on every tick, and the line churns through
 * words while nothing has actually changed -- so what changed is decided on
 * what the report says, not on which object it arrived in.
 *
 * The kind is prefixed rather than merged with the name, so a tool that
 * happens to be called `thinking` is still a different step from the model
 * thinking.
 */
export function activityKey(activity: AgentActivity | undefined): string {
  if (!activity) return 'none';
  return activity.kind === 'thinking' ? activity.kind : `${activity.kind}:${activity.name}`;
}

/** What kind of work this is, as far as the line on screen is concerned. */
export function themeFor(activity: AgentActivity | undefined): Theme {
  if (!activity || activity.kind === 'thinking') return 'reasoning';
  // A skill is a document the agent reads before acting, whatever it is about.
  if (activity.kind === 'skill') return 'reading';
  if (WRITING_TOOLS.has(activity.name)) return 'writing';
  for (const [prefix, theme] of THEME_PREFIXES) {
    if (activity.name.startsWith(prefix)) return theme;
  }
  // An unrecognised tool still gets a word. Blanking the line because a name
  // is missing from a table here would be the worst of both.
  return 'reasoning';
}

/** The common ones. Roughly four times out of five, the line says one of these. */
export const BASIC_PHRASES: readonly Phrase[] = [
  { text: 'Thinking…', themes: 'any' },
  { text: 'Calculating…', themes: ['reasoning'] },
  { text: 'Reasoning…', themes: 'any' },
  { text: 'Processing…', themes: 'any' },
  { text: 'Analyzing…', themes: ['reasoning', 'coursework', 'files', 'reading', 'mail'] },
  { text: 'Evaluating…', themes: ['reasoning', 'coursework', 'reading'] },
  { text: 'Computing…', themes: ['reasoning'] },
  { text: 'Formulating…', themes: ['reasoning', 'writing'] },
  { text: 'Assessing…', themes: ['reasoning', 'coursework', 'reading', 'files'] },
  { text: 'Synthesizing…', themes: ['reasoning', 'reading', 'files', 'coursework'] },
  { text: 'Decoding…', themes: ['reading', 'files', 'browsing', 'mail'] },
  { text: 'Examining…', themes: ['reading', 'files', 'coursework', 'mail', 'browsing'] },
  { text: 'Interpreting…', themes: ['reading', 'files', 'coursework', 'mail'] },
  { text: 'Structuring…', themes: ['writing', 'coursework'] },
  { text: 'Mapping…', themes: ['coursework', 'browsing', 'files'] },
  { text: 'Connecting…', themes: ['browsing', 'mail', 'reasoning'] },
  { text: 'Solving…', themes: ['reasoning', 'coursework'] },
  { text: 'Weighing…', themes: ['reasoning', 'coursework'] },
  { text: 'Deconstructing…', themes: ['reasoning', 'reading', 'coursework'] },
  { text: 'Cross-referencing…', themes: ['mail', 'coursework', 'files', 'browsing'] },
  { text: 'Optimizing…', themes: ['reasoning', 'writing'] },
  { text: 'Verifying…', themes: 'any' },
  { text: 'Balancing…', themes: ['reasoning', 'coursework'] },
  { text: 'Drafting…', themes: ['writing', 'mail'] },
  { text: 'Brainstorming…', themes: ['reasoning', 'writing'] },
  { text: 'Working…', themes: 'any' },
  { text: 'Updating the plan…', themes: ['reasoning'] },
  { text: 'Unpacking…', themes: ['files', 'mail', 'reading', 'browsing'] },
  { text: 'Synergizing…', themes: ['reasoning', 'coursework', 'writing'] },
];

/** The rare ones. Roughly one time in five, and never the default. */
export const NICHE_PHRASES: readonly Phrase[] = [
  { text: 'Ai-slopping…', themes: 'any' },
  { text: 'Mogging…', themes: 'any' },
  { text: 'Larping…', themes: ['browsing', 'reading', 'writing'] },
  { text: 'Locking-in…', themes: 'any' },
  { text: 'Cooking…', themes: 'any' },
  { text: 'Saving your ahh…', themes: ['coursework', 'writing', 'mail'] },
  { text: 'Deep frying…', themes: ['reasoning', 'files', 'reading'] },
  { text: 'No cap-ing this…', themes: ['reading', 'mail', 'browsing', 'coursework'] },
  { text: 'Ratio-checking…', themes: ['reasoning', 'coursework'] },
  { text: 'Rizzing up an answer…', themes: ['writing', 'mail', 'reasoning'] },
  { text: 'Unhinged-ly considering…', themes: ['reasoning'] },
  { text: 'Manifesting an answer…', themes: 'any' },
  { text: 'Lowkey figuring it out…', themes: 'any' },
  { text: 'Gatekeeping the wrong answer…', themes: ['reasoning', 'coursework'] },
  { text: 'Delulu-checking…', themes: ['reasoning', 'reading', 'browsing'] },
  { text: 'Fr fr analyzing…', themes: ['reasoning', 'coursework', 'reading', 'files', 'mail'] },
  { text: 'Ok this is mid, retrying…', themes: ['browsing', 'reading', 'files'] },
  { text: 'Main-character-ing the response…', themes: ['writing', 'mail'] },
  { text: 'Yeeting the wrong ideas…', themes: ['reasoning', 'coursework'] },
  { text: 'Glazing the correct answer…', themes: ['reasoning', 'coursework'] },
  { text: 'Touching grass…', themes: 'any' },
  { text: 'Aura-farming…', themes: 'any' },
  { text: 'Mewing…', themes: 'any' },
  { text: 'Mogging the problem…', themes: ['reasoning', 'coursework'] },
  { text: 'Ick-checking the logic…', themes: ['reasoning', 'coursework', 'writing'] },
  { text: 'Ghosting the wrong answer…', themes: ['reasoning', 'mail'] },
  { text: 'Ate and left no crumbs…', themes: ['writing', 'files', 'mail'] },
  { text: 'Bussin-checking the output…', themes: ['reasoning', 'writing', 'files', 'browsing'] },
];

/** How often the rare list wins. Kept here so the test and the code agree. */
export const NICHE_SHARE = 0.2;

/** The phrases from one list that suit a kind of work. */
export function phrasesFor(theme: Theme, from: readonly Phrase[]): readonly Phrase[] {
  return from.filter((p) => p.themes === 'any' || p.themes.includes(theme));
}

export interface PickOptions {
  /** Phrases not to pick again -- what is on screen, and what came just before. */
  avoid?: readonly string[];
  /** Injected so a test can pin the weighting down. Defaults to Math.random. */
  random?: () => number;
}

/**
 * One phrase, fitting the work, weighted towards the common ones.
 *
 * The register is drawn first and the phrase second, so the rare list stays
 * rare regardless of how many phrases happen to fit the current theme --
 * drawing from one merged pool would make niche phrases commoner exactly when
 * few basic ones matched, which is backwards.
 */
export function pickPhrase(activity: AgentActivity | undefined, options: PickOptions = {}): string {
  const { avoid = [], random = Math.random } = options;
  const theme = themeFor(activity);

  const wanted = random() < NICHE_SHARE ? NICHE_PHRASES : BASIC_PHRASES;
  const fitting = phrasesFor(theme, wanted);
  const fresh = fitting.filter((p) => !avoid.includes(p.text));

  /*
   * A turn long enough to work through everything that fits still has to say
   * something, and repeating beats going blank. Falling back within the same
   * register keeps a rare phrase from being handed out as the safe default.
   */
  const pool = fresh.length > 0 ? fresh : fitting;
  return pool[Math.floor(random() * pool.length)]?.text ?? 'Thinking…';
}
