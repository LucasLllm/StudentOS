import type { SourceKind } from '@contexto/shared';
import { untrustedNote } from '../untrusted.js';

/**
 * What a project chat is told about its project, as one frozen block of text.
 *
 * Rendered on the chat's first turn and replayed byte for byte on every turn
 * after, because the system prompt is cached as a whole: one changed byte and
 * the provider serves none of it from cache (see buildTurnContext). So this is
 * a pure function of its input, sorted so the order rows come back in cannot
 * change it, and nothing in it reads the clock.
 *
 * Two shapes, chosen by size. A small project is carried whole: every page of
 * it, cached, costs a tenth of its price after the first turn and the model
 * never has to go looking. A large one carries only the manifest and reads on
 * demand. The manifest is there in both, and that is the part that matters --
 * what goes wrong with retrieval over a project is a model reasoning from
 * fragments with no idea what else exists. Told every item by name and what it
 * is, it opens the one it needs, whole.
 */

/**
 * The most context carried in full, in estimated tokens.
 *
 * Twenty thousand is a few long documents. Cached, that is the price of two
 * thousand uncached tokens a turn, and well inside where a model still attends
 * to all of what it is given; past it, a project is cheaper and no worse read on
 * demand.
 */
export const INLINE_LIMIT_TOKENS = 20_000;

export interface BlockSource {
  id: string;
  /** The note's name, which is how the agent opens it. */
  name: string;
  kind: SourceKind;
  summary: string;
  tokens: number;
  /** The note's text. Only read when the project is small enough to carry whole. */
  body?: string;
  /**
   * Written by someone other than the student -- a teacher's email, a shared
   * Drive file. Carried inside the untrusted block the rest of the vault uses.
   */
  untrusted?: boolean;
}

export interface BlockProject {
  name: string;
  instructions: string;
  memory: string;
}

/** Short enough to cost nothing in a manifest line, long enough never to collide in one project. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

function manifestLine(source: BlockSource): string {
  return `- [${shortId(source.id)}] ${source.name} (${source.kind}): ${source.summary}`;
}

/** Name first, id to break a tie: a stable order that owes nothing to the database. */
function sorted(sources: readonly BlockSource[]): BlockSource[] {
  return [...sources].sort((a, b) =>
    a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name),
  );
}

/** Stop an imported note closing the untrusted block it sits in. See vault/render.ts. */
function defang(body: string): string {
  return body.replaceAll('<', '‹').replaceAll('>', '›');
}

const EMPTY = 'Nothing has been added to the project context yet.';
const TOO_LARGE =
  'The context is too large to carry whole, so only the list is here. Use project_search to ' +
  'find passages across it and project_open to read an item in full before relying on it.';

export function renderProjectBlock(project: BlockProject, sources: readonly BlockSource[]): string {
  const sections = [`Project: ${project.name.trim()}`];

  if (project.instructions.trim()) {
    sections.push(
      `The student's goal for this project, in their words:\n${project.instructions.trim()}`,
    );
  }
  if (project.memory.trim()) {
    sections.push(`What earlier chats in this project established:\n${project.memory.trim()}`);
  }

  const items = sorted(sources);
  if (items.length === 0) {
    sections.push(`Project context:\n${EMPTY}`);
    return sections.join('\n\n');
  }

  sections.push(
    `Project context (${items.length} ${items.length === 1 ? 'item' : 'items'}):\n` +
      items.map(manifestLine).join('\n'),
  );

  const total = items.reduce((sum, source) => sum + source.tokens, 0);
  if (total > INLINE_LIMIT_TOKENS) {
    sections.push(TOO_LARGE);
    return sections.join('\n\n');
  }

  const ours = items.filter((source) => !source.untrusted);
  const theirs = items.filter((source) => source.untrusted);
  const whole = (source: BlockSource, body: string) => `### ${source.name}\n${body.trim()}`;

  const parts = ['The full text of each item follows.'];
  for (const source of ours) parts.push(whole(source, source.body ?? ''));
  if (theirs.length > 0) {
    parts.push(
      '<untrusted>\n' +
        untrustedNote('The items below were written by other people, not by the student.') +
        '\n\n' +
        theirs.map((source) => whole(source, defang(source.body ?? ''))).join('\n\n') +
        '\n</untrusted>',
    );
  }
  sections.push(parts.join('\n\n'));

  return sections.join('\n\n');
}

/** The manifest lines a frozen block carries, keyed by short id. */
function frozenManifest(block: string): Map<string, string> {
  const lines = new Map<string, string>();
  /*
   * Only the manifest itself: the section from its heading to the next blank
   * line. A document carried whole below it can contain anything, including a
   * line shaped like an entry, and reading one as an item would announce it
   * removed on every turn.
   */
  const start = block.search(/^Project context \(/m);
  if (start === -1) return lines;
  const end = block.indexOf('\n\n', start);
  const manifest = block.slice(start, end === -1 ? undefined : end);
  for (const match of manifest.matchAll(/^- \[([^\]]+)\] (\S+) \(/gm)) {
    if (match[1] && match[2]) lines.set(match[1], match[2]);
  }
  return lines;
}

/**
 * What has changed in the context since the block was frozen.
 *
 * Told in the turn context, which is rebuilt every turn anyway, so an item a
 * student adds in one chat is known at once in every other open chat of the
 * project without costing any of them their cache. Null when nothing changed,
 * which is almost every turn.
 */
export function projectDiff(block: string, current: readonly BlockSource[]): string | null {
  const frozen = frozenManifest(block);
  const now = new Set(current.map((source) => shortId(source.id)));

  const added = sorted(current).filter((source) => !frozen.has(shortId(source.id)));
  const removed = [...frozen]
    .filter(([id]) => !now.has(id))
    .map(([, name]) => name)
    .sort();

  if (added.length === 0 && removed.length === 0) return null;

  const lines: string[] = [];
  if (added.length > 0) {
    lines.push(
      'Added to the project context since this chat started (read them with project_open):\n' +
        added.map(manifestLine).join('\n'),
    );
  }
  if (removed.length > 0) {
    lines.push(`Removed from the project context: ${removed.join(', ')}. Do not rely on them.`);
  }
  return lines.join('\n');
}

/** chars / 4, the estimate the transcript budget already uses. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
