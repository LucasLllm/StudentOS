import { eq } from 'drizzle-orm';
import { projects } from '@contexto/db';
import {
  CHATS_DOC_NAME,
  USER_DOC_NAME,
  Vault,
  isUnavailable,
  listDriveFiles,
  queryTerms,
  rankByTermMatches,
  searchMail,
  type ProjectRef,
  type ToolContext,
} from '@contexto/agent';
import type { LlmProvider } from '@contexto/llm';
import type { AppContext } from '../context.js';
import { DbProjectAccess, googleContext } from './sources.js';

/**
 * The agent gathering a new project's context, before anybody asks it to.
 *
 * What neither ChatGPT nor Claude does: a student names a project and says
 * what it is for, and by the time they have read the page, the brief from the
 * teacher's email, the draft in Drive and the notes already in their vault are
 * in it.
 *
 * Two small calls, whatever the size of the vault or the inbox. The first
 * turns the project into a handful of searches; the searches cost nothing but
 * API calls; the second reads only titles and a line of each result and picks.
 * Nothing is read whole until it has been chosen. What is chosen is added
 * exactly as project_add adds it, so an item looks the same however it came.
 */

/** A chosen few, not a dump. Eight is a working set a student can glance over. */
export const MAX_GATHERED = 8;
const RESULTS_PER_SEARCH = 5;

export interface Candidate {
  ref: ProjectRef;
  /** What it is called, and where it came from, for the picking call. */
  title: string;
  where: 'vault' | 'mail' | 'drive';
  snippet: string;
}

/** Where candidates come from. Injected so a test can hand over a list. */
export interface Searchers {
  vault(query: string): Promise<Candidate[]>;
  mail(query: string): Promise<Candidate[]>;
  drive(query: string): Promise<Candidate[]>;
}

type Chat = Pick<LlmProvider, 'chat'>;

/** The first JSON object in a reply, or null. Models wrap JSON in prose and fences. */
function json(text: string): Record<string, unknown> | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function ask(llm: Chat, userId: string, system: string, user: string): Promise<string> {
  const response = await llm.chat(
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      effort: 'low',
      maxOutputTokens: 600,
    },
    { userId },
  );
  return typeof response.content === 'string' ? response.content : '';
}

/** Short keyword searches, because Drive matches on file names and Gmail on words. */
export async function searchesFor(
  llm: Chat,
  input: { userId: string; name: string; instructions: string },
): Promise<string[]> {
  const reply = await ask(
    llm,
    input.userId,
    'You plan searches. You reply with JSON only.',
    [
      'A student started a project. Write 3 to 5 short searches, each one to three keywords,',
      'that would find the documents, notes and emails already in their files that belong to it:',
      'a brief or assignment, drafts, feedback, the people involved, the subject.',
      'Specific words, not generic ones like "project" or "document".',
      'Reply as {"queries": ["...", "..."]}.',
      '',
      `Project: ${input.name}`,
      `Goal: ${input.instructions || '(none given)'}`,
    ].join('\n'),
  );
  const queries = json(reply)?.['queries'];
  if (!Array.isArray(queries)) return [];
  return [
    ...new Set(
      queries
        .filter((query): query is string => typeof query === 'string')
        .map((query) => query.trim())
        .filter((query) => query.length >= 2 && query.length <= 60),
    ),
  ].slice(0, 5);
}

/** The model picks from numbered candidates, by title and a line of each. */
export async function pick(
  llm: Chat,
  input: { userId: string; name: string; instructions: string; candidates: Candidate[] },
): Promise<Candidate[]> {
  if (input.candidates.length === 0) return [];
  const listed = input.candidates
    .map(
      (candidate, index) =>
        `${index + 1}. [${candidate.where}] ${candidate.title} -- ${candidate.snippet.slice(0, 200)}`,
    )
    .join('\n');
  const reply = await ask(
    llm,
    input.userId,
    'You choose what belongs in a project. You reply with JSON only.',
    [
      `Which of these belong in the student's project? Choose at most ${MAX_GATHERED}, only`,
      'ones clearly about this project, the most useful first. Choosing none is fine.',
      'Reply as {"pick": [numbers]}.',
      '',
      `Project: ${input.name}`,
      `Goal: ${input.instructions || '(none given)'}`,
      '',
      listed,
    ].join('\n'),
  );
  const chosen = json(reply)?.['pick'];
  if (!Array.isArray(chosen)) return [];
  const seen = new Set<number>();
  const out: Candidate[] = [];
  for (const value of chosen) {
    const index = typeof value === 'number' ? value - 1 : Number.NaN;
    const candidate = input.candidates[index];
    if (!candidate || seen.has(index)) continue;
    seen.add(index);
    out.push(candidate);
    if (out.length === MAX_GATHERED) break;
  }
  return out;
}

/** The same thing found twice -- by two searches, or in two places -- is one candidate. */
function keyOf(ref: ProjectRef): string {
  if ('note' in ref) return `note:${ref.note}`;
  if ('driveFileId' in ref) return `drive:${ref.driveFileId}`;
  return `mail:${ref.gmailMessageId}`;
}

/**
 * Run the sweep: plan, search, pick, add.
 *
 * Returns how many items it added. Marks the project gathered whatever
 * happens, because the page shows "Gathering" until it does, and a sweep that
 * failed quietly must not leave that on screen for ever.
 */
export async function gatherContext(
  deps: {
    llm: Chat;
    searchers: Searchers;
    add: (ref: ProjectRef) => Promise<unknown>;
    done: () => Promise<void>;
  },
  input: { userId: string; name: string; instructions: string },
): Promise<number> {
  try {
    const queries = await searchesFor(deps.llm, input);
    if (queries.length === 0) return 0;

    const found = new Map<string, Candidate>();
    for (const query of queries) {
      const results = await Promise.all([
        deps.searchers.vault(query).catch(() => []),
        deps.searchers.mail(query).catch(() => []),
        deps.searchers.drive(query).catch(() => []),
      ]);
      for (const candidate of results.flat()) {
        const key = keyOf(candidate.ref);
        if (!found.has(key)) found.set(key, candidate);
      }
    }

    const chosen = await pick(deps.llm, { ...input, candidates: [...found.values()] });
    let added = 0;
    for (const candidate of chosen) {
      const result = await deps.add(candidate.ref).catch(() => ({ error: 'failed' }));
      if (result && typeof result === 'object' && !('error' in result)) added += 1;
    }
    return added;
  } catch {
    return 0;
  } finally {
    await deps.done().catch(() => undefined);
  }
}

/** The student's own vault, Gmail and Drive, as candidate sources. */
export function liveSearchers(ctx: AppContext, userId: string, google: ToolContext): Searchers {
  return {
    async vault(query) {
      const root = ctx.env?.VAULT_ROOT;
      if (!root) return [];
      const vault = new Vault(root, userId);
      const [entities, documents] = await Promise.all([
        vault.list('entity'),
        vault.list('document'),
      ]);
      /*
       * Not the pages about the student themselves: they are carried on every
       * turn of every chat already, and a project holding a copy of "who this
       * student is" would pay for it twice.
       */
      const notes = [...entities, ...documents].filter(
        (note) => note.name !== USER_DOC_NAME && note.name !== CHATS_DOC_NAME,
      );
      const ranked = rankByTermMatches(
        notes.map((note) => ({
          note,
          content: `${note.name.replaceAll('-', ' ')} ${note.description} ${note.body}`,
          occurredAt: new Date(note.occurred ?? 0),
        })),
        queryTerms(query),
      );
      return ranked.slice(0, RESULTS_PER_SEARCH).map(({ note }) => ({
        ref: { note: note.name },
        title: note.description || note.name,
        where: 'vault' as const,
        snippet: note.body.replace(/\s+/g, ' ').slice(0, 200),
      }));
    },

    async mail(query) {
      const result = await searchMail.execute({ query, limit: RESULTS_PER_SEARCH }, google);
      if (isUnavailable(result)) return [];
      const messages =
        (
          result as {
            messages?: { messageId: string; subject?: string; from?: string; snippet?: string }[];
          }
        ).messages ?? [];
      return messages.map((message) => ({
        ref: { gmailMessageId: message.messageId },
        title: `${message.subject ?? '(no subject)'} -- from ${message.from ?? 'unknown'}`,
        where: 'mail' as const,
        snippet: message.snippet ?? '',
      }));
    },

    async drive(query) {
      const result = await listDriveFiles.execute({ search: query }, google);
      if (isUnavailable(result)) return [];
      const files =
        (result as { files?: { fileId: string; name: string; kind: string }[] }).files ?? [];
      return files
        .filter((file) => file.kind !== 'Folder')
        .slice(0, RESULTS_PER_SEARCH)
        .map((file) => ({
          ref: { driveFileId: file.fileId },
          title: file.name,
          where: 'drive' as const,
          snippet: file.kind,
        }));
    },
  };
}

/** Start the sweep for a new project and return at once. */
export function startGathering(
  ctx: AppContext,
  input: { userId: string; projectId: string },
): void {
  void (async () => {
    const done = async () => {
      await ctx.db
        .update(projects)
        .set({ gatheredAt: new Date() })
        .where(eq(projects.id, input.projectId));
    };
    try {
      const [project] = await ctx.db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);
      if (!project) return;
      const google = await googleContext(ctx, input.userId);
      const access = new DbProjectAccess(ctx, ctx.llm, input.userId, input.projectId);
      await gatherContext(
        {
          llm: ctx.llm,
          searchers: liveSearchers(ctx, input.userId, google),
          add: (ref) => access.add(ref),
          done,
        },
        { userId: input.userId, name: project.name, instructions: project.instructions },
      );
    } catch (error) {
      console.error(`Gathering context failed for project ${input.projectId}`, error);
      await done().catch(() => undefined);
    }
  })();
}
