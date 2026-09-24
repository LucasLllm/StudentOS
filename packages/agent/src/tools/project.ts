import { z } from 'zod';
import { queryTerms, rankByTermMatches } from '../memory/search.js';
import { untrustedNote } from '../untrusted.js';
import type { ProjectItem, Tool, ToolContext } from './types.js';

/**
 * Reading a project's context, and adding to it.
 *
 * Registered only for chats that belong to a project. A small project is
 * already in the system prompt whole and these are rarely needed; a large one
 * carries only its manifest, and these are how the model reads what the
 * manifest names. project_add is how the agent gathers context itself: what it
 * finds in the vault, Drive or mail and uses, it brings into the project so the
 * next chat starts with it.
 */

const NOT_A_PROJECT = 'This chat is not part of a project.';

/** About 400 tokens: enough to hold a paragraph's argument, small enough that six cost little. */
const PASSAGE_CHARS = 1_500;

/** About 4,000 tokens a part, so a hundred-page PDF never lands in one tool result. */
export const PART_CHARS = 16_000;

/**
 * A body cut into pieces of about `size` characters, on paragraph boundaries.
 *
 * A paragraph longer than the size is cut on its own, hard, rather than
 * carried whole: one wall of extracted PDF text with no blank lines in it is
 * exactly the document this exists for.
 */
function pieces(body: string, size: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const paragraph of body.split(/\n\s*\n/)) {
    const text = paragraph.trim();
    if (!text) continue;
    if (current && current.length + text.length + 2 > size) {
      out.push(current);
      current = '';
    }
    if (text.length > size) {
      for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
      continue;
    }
    current = current ? `${current}\n\n${text}` : text;
  }
  if (current) out.push(current);
  return out;
}

function defang(body: string): string {
  return body.replaceAll('<', '‹').replaceAll('>', '›');
}

const UNTRUSTED_WARNING = untrustedNote(
  'What follows was written by other people -- a teacher, a school, whoever sent the mail -- not by the student.',
);

/** One item's text, wrapped the way the rest of the vault is when someone else wrote it. */
function rendered(item: ProjectItem, heading: string, text: string): string {
  if (!item.untrusted) return `${heading}\n${text}`;
  return `${heading}\n<untrusted>\n${UNTRUSTED_WARNING}\n\n${defang(text)}\n</untrusted>`;
}

async function itemsOf(ctx: ToolContext): Promise<ProjectItem[] | null> {
  return ctx.project ? await ctx.project.items() : null;
}

const searchInput = z.object({
  query: z.string().min(2).describe('Words to look for across the project context.'),
  limit: z.number().int().min(1).max(10).optional().describe('How many passages. Defaults to 5.'),
});

export const searchProject: Tool<z.infer<typeof searchInput>, string> = {
  id: 'project_search',
  description:
    "Search this project's context -- the documents, notes and emails that belong to it -- and " +
    'get back the passages that match, each named by the item it came from. Use it when the ' +
    'project context is too large to be in front of you whole, or to find where something is ' +
    'said. Then open the item with project_open before relying on a passage out of context.',
  inputSchema: searchInput,
  async execute(input, ctx) {
    const items = await itemsOf(ctx);
    if (!items) return NOT_A_PROJECT;

    const terms = queryTerms(input.query);
    /*
     * Passages, not items, are what is ranked.
     *
     * Ranked whole, a long manual that mentions a word once beats a short note
     * that is entirely about it, and returning it would put thousands of words
     * around the one sentence that matched. Each passage carries its item's
     * name and summary so a match on what the item is about still counts.
     */
    const passages = items.flatMap((item) =>
      pieces(item.body, PASSAGE_CHARS).map((text, index) => ({
        item,
        text,
        content: `${item.name.replaceAll('-', ' ')} ${item.summary} ${text}`,
        // Earlier passages first on a tie: a document's opening says what it is.
        occurredAt: new Date(-index),
      })),
    );

    const hits = rankByTermMatches(passages, terms).slice(0, input.limit ?? 5);
    if (hits.length === 0) return `Nothing in the project context matches "${input.query}".`;

    return (
      hits
        .map(({ item, text }) => rendered(item, `## ${item.name} (${item.summary})`, text))
        .join('\n\n') + '\n\nOpen an item whole with project_open.'
    );
  },
};

const openInput = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .describe('The item to open, as named in the project context, or the short id in brackets.'),
  part: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('For a long item, which part to read. Starts at 1.'),
});

export const openProjectItem: Tool<z.infer<typeof openInput>, string> = {
  id: 'project_open',
  description:
    "Read one item of this project's context in full: pass its name as listed in the project " +
    'context. Long items come in numbered parts; the first part says how many there are. Use ' +
    'it before answering from an item that is listed but not in front of you.',
  inputSchema: openInput,
  async execute(input, ctx) {
    const items = await itemsOf(ctx);
    if (!items) return NOT_A_PROJECT;

    /*
     * By name, or by the id the manifest shows in brackets -- with or without
     * the version after the dot. The id is what tells two items apart when a
     * linked note and one brought into the project happen to share a name.
     */
    const wanted = input.name.trim().replace(/^\[|\]$/g, '');
    const id = /^([0-9a-f]{8})(?:\.[0-9a-f]+)?$/i.exec(wanted)?.[1];
    const named = items.filter((candidate) => candidate.name === wanted);
    const byId = id ? items.filter((candidate) => candidate.id.startsWith(id)) : [];
    const matches = named.length > 0 ? named : byId;

    if (matches.length > 1) {
      return (
        `Several items are called "${wanted}". Open one by its id:\n` +
        matches
          .map(
            (candidate) =>
              `- ${candidate.id.slice(0, 8)} (${candidate.kind}): ${candidate.summary}`,
          )
          .join('\n')
      );
    }
    const item = matches[0];

    if (!item) {
      if (items.length === 0) return 'Nothing has been added to the project context yet.';
      return (
        `There is no item called "${input.name}" in this project. ` +
        `The ones there are: ${items.map((candidate) => candidate.name).join(', ')}.`
      );
    }

    const parts = pieces(item.body, PART_CHARS);
    if (parts.length <= 1) {
      return rendered(item, `## ${item.name} (${item.summary})`, item.body.trim());
    }

    const index = Math.min(input.part ?? 1, parts.length);
    const more = index < parts.length ? ` Ask for part ${index + 1} to read on.` : '';
    return rendered(
      item,
      `## ${item.name} (${item.summary}) -- part ${index} of ${parts.length}.${more}`,
      parts[index - 1] ?? '',
    );
  },
};

const addInput = z
  .object({
    note: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("A note from the student's vault, by name, as vault_search returned it."),
    driveFileId: z.string().min(1).optional().describe('A Google Drive file id.'),
    gmailMessageId: z.string().min(1).optional().describe('A Gmail message id, from gmail_search.'),
  })
  .refine(
    (input) =>
      [input.note, input.driveFileId, input.gmailMessageId].filter((ref) => ref !== undefined)
        .length === 1,
    { message: 'Name exactly one of note, driveFileId or gmailMessageId.' },
  );

export const addToProject: Tool<z.infer<typeof addInput>, string> = {
  id: 'project_add',
  description:
    "Add something to this project's context so every chat in the project has it from now on: " +
    "a note from the student's vault, a Drive file, or an email. Call it when you used " +
    'something from outside the project that the project will need again -- a brief, a rubric, ' +
    "a teacher's instructions, a draft. Not for things you only glanced at or that turned out " +
    'to be irrelevant. Pass exactly one of note, driveFileId or gmailMessageId.',
  inputSchema: addInput,
  async execute(input, ctx) {
    if (!ctx.project) return NOT_A_PROJECT;

    const ref = input.note
      ? { note: input.note }
      : input.driveFileId
        ? { driveFileId: input.driveFileId }
        : { gmailMessageId: input.gmailMessageId as string };

    const result = await ctx.project.add(ref);
    if ('error' in result) return result.error;
    return result.added
      ? `Added "${result.name}" to the project context.`
      : `"${result.name}" is already in the project context.`;
  },
};

/** Registered together, for a project chat only. Typed as the registry takes them, like ALL_TOOLS. */
export const PROJECT_TOOLS = [searchProject, openProjectItem, addToProject] as unknown as Tool<
  never,
  unknown
>[];
