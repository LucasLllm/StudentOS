import { and, eq } from 'drizzle-orm';
import { projectSources, projects } from '@contexto/db';
import {
  Vault,
  estimateTextTokens,
  importUpload,
  isUnavailable,
  isUntrusted,
  projectVault,
  readDriveFile,
  readMail,
  sourceKindFor,
  sourceKindForNote,
  summariseSource,
  textFromDriveRead,
  uploadNoteName,
  type BlockSource,
  type NoteKind,
  type ProjectAccess,
  type ProjectItem,
  type ProjectRef,
  type ToolContext,
  type UploadResult,
  type VaultNote,
} from '@contexto/agent';
import type { LlmProvider } from '@contexto/llm';
import { ContextoError, type SourceKind } from '@contexto/shared';
import type { AppContext } from '../context.js';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from '../google/connections.js';

/**
 * A project's context: what is in it, and every way of putting something there.
 *
 * Every path in -- an upload, pasted text, a Drive file the student picked,
 * whatever the agent brings in itself -- ends at addSource, so a context item
 * is written one way whoever wrote it, and none of them is marked as coming
 * from anywhere in particular.
 */

type SourceRow = typeof projectSources.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/** The model that writes one-line summaries, billed like a turn. */
type Summariser = Pick<LlmProvider, 'chat'>;

export function vaultRootOf(ctx: AppContext): string {
  const root = ctx.env?.VAULT_ROOT;
  if (!root) {
    throw new ContextoError(
      'validation_failed',
      'This deployment has no vault to keep projects in.',
    );
  }
  return root;
}

/** The caller's project, or not found -- never somebody else's. */
export async function ownedProject(
  ctx: AppContext,
  userId: string,
  projectId: string,
): Promise<ProjectRow> {
  // A malformed id is a 404 rather than a Postgres cast error surfacing as a 500.
  if (!/^[0-9a-f-]{36}$/i.test(projectId))
    throw new ContextoError('not_found', 'Project not found.');
  const [row] = await ctx.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!row) throw new ContextoError('not_found', 'Project not found.');
  return row;
}

/** The vault a source's note lives in: the project's own, or the student's. */
function vaultFor(root: string, userId: string, projectId: string, owned: boolean): Vault {
  return owned ? projectVault(root, userId, projectId) : new Vault(root, userId);
}

export async function noteOf(
  root: string,
  userId: string,
  row: Pick<SourceRow, 'projectId' | 'owned' | 'noteKind' | 'noteName'>,
): Promise<VaultNote | null> {
  return vaultFor(root, userId, row.projectId, row.owned).read(row.noteKind, row.noteName);
}

/** Moved to the top of the list because something in it changed. */
export async function touchProject(ctx: AppContext, projectId: string): Promise<void> {
  await ctx.db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
}

/**
 * Whether the project is still there.
 *
 * Checked before anything is written for it. An add can take seconds -- a
 * Drive read, a summary call -- and a project deleted meanwhile must not have
 * its folder re-created under it holding somebody's email.
 */
export async function projectAlive(ctx: AppContext, projectId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return Boolean(row);
}

/**
 * A name for a note that does not take another one's place.
 *
 * Titles repeat -- two Drive files called "Untitled document", two emails
 * both "Re: Assignment" -- and a name is what decides which note is written.
 * The same source again (same Drive file, same message) keeps its name, so
 * adding it twice is still one item; anything else gets the next free one.
 */
async function freeName(vault: Vault, base: string, externalId?: string): Promise<string> {
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const existing = await vault.read('entity', candidate);
    if (!existing) return candidate;
    if (externalId && existing.externalId === externalId) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

const GONE = { error: 'That project no longer exists.' } as const;

/**
 * Put a note into a project's context.
 *
 * The note is already written; this records it, sized and summarised. Adding
 * the same note again refreshes the row rather than refusing -- an upload of
 * a revised file replaces its note, and its summary and size should follow.
 */
export async function addSource(
  ctx: AppContext,
  llm: Summariser,
  input: {
    userId: string;
    projectId: string;
    noteName: string;
    noteKind: NoteKind;
    owned: boolean;
    kind: SourceKind;
    image?: boolean;
  },
): Promise<{ row: SourceRow; added: boolean } | null> {
  const root = vaultRootOf(ctx);
  if (!(await projectAlive(ctx, input.projectId))) return null;
  const note = await vaultFor(root, input.userId, input.projectId, input.owned).read(
    input.noteKind,
    input.noteName,
  );
  if (!note) return null;

  const [existing] = await ctx.db
    .select({ id: projectSources.id })
    .from(projectSources)
    .where(
      and(
        eq(projectSources.projectId, input.projectId),
        eq(projectSources.owned, input.owned),
        eq(projectSources.noteKind, input.noteKind),
        eq(projectSources.noteName, input.noteName),
      ),
    )
    .limit(1);

  const summary = await summariseSource(
    { llm },
    {
      userId: input.userId,
      title: note.description || note.name,
      body: note.body,
      untrusted: isUntrusted(note.source),
    },
  );
  const values = {
    projectId: input.projectId,
    noteName: input.noteName,
    noteKind: input.noteKind,
    owned: input.owned,
    kind: input.kind,
    summary,
    tokens: estimateTextTokens(note.body),
    image: input.image ?? false,
  };

  let row: SourceRow | undefined;
  try {
    [row] = await ctx.db
      .insert(projectSources)
      .values(values)
      .onConflictDoUpdate({
        target: [
          projectSources.projectId,
          projectSources.owned,
          projectSources.noteKind,
          projectSources.noteName,
        ],
        set: { summary, tokens: values.tokens, kind: values.kind, image: values.image },
      })
      .returning();
  } catch (error) {
    /*
     * The project went while this was being summarised: the row cannot point
     * at it, and a note written for it has nowhere to belong. Take the note
     * back out rather than leave it on disk with nothing listing it.
     */
    if (input.owned && !(await projectAlive(ctx, input.projectId))) {
      await projectVault(root, input.userId, input.projectId).remove(
        input.noteKind,
        input.noteName,
      );
      return null;
    }
    throw error;
  }
  if (!row) return null;

  await touchProject(ctx, input.projectId);
  return { row, added: !existing };
}

/** A file from the student's machine, into the project's own vault. */
export async function addUpload(
  ctx: AppContext,
  llm: Summariser & Partial<LlmProvider>,
  input: { userId: string; projectId: string; file: File; context?: string },
): Promise<{ result: UploadResult; row?: SourceRow }> {
  if (!(await projectAlive(ctx, input.projectId))) {
    throw new ContextoError('not_found', 'Project not found.');
  }
  const vault = projectVault(vaultRootOf(ctx), input.userId, input.projectId);
  const result = await importUpload(
    vault,
    {
      filename: input.file.name,
      mimeType: input.file.type,
      bytes: new Uint8Array(await input.file.arrayBuffer()),
    },
    {
      llm: llm as LlmProvider,
      userId: input.userId,
      ...(input.context ? { context: input.context } : {}),
    },
  );
  if (!result.ok) return { result };

  const added = await addSource(ctx, llm, {
    userId: input.userId,
    projectId: input.projectId,
    noteName: result.name,
    noteKind: 'entity',
    owned: true,
    kind: sourceKindFor(input.file.name, input.file.type),
    image: result.image,
  });
  return { result, ...(added ? { row: added.row } : {}) };
}

/** Something typed or pasted in, kept as a note of the student's own. */
export async function addText(
  ctx: AppContext,
  llm: Summariser,
  input: { userId: string; projectId: string; title: string; body: string },
): Promise<SourceRow | null> {
  if (!(await projectAlive(ctx, input.projectId))) return null;
  const vault = projectVault(vaultRootOf(ctx), input.userId, input.projectId);
  // Always a note of its own: pasting a second note with the same title is a second note.
  const name = await freeName(vault, uploadNoteName(input.title) || 'note');
  await vault.write({
    name,
    kind: 'entity',
    source: 'student',
    description: input.title,
    body: input.body.trim(),
  });
  const added = await addSource(ctx, llm, {
    userId: input.userId,
    projectId: input.projectId,
    noteName: name,
    noteKind: 'entity',
    owned: true,
    kind: 'text',
  });
  return added?.row ?? null;
}

/** What the Google tools need to read on the student's behalf, outside a turn. */
export async function googleContext(ctx: AppContext, userId: string): Promise<ToolContext> {
  const grant = await getGoogleGrant(ctx.db, userId);
  /*
   * Without what the student switched off. A turn never registers the tools
   * of a disabled integration; reading on their behalf outside a turn must
   * not reach round that -- a student who turned Gmail off has said so.
   */
  const disabled = new Set<string>(grant.disabled);
  const groups = grant.groups.filter((group) => !disabled.has(group));
  return {
    userId,
    agentId: '',
    google: new BetterAuthGoogleTokenProvider(ctx.auth, userId, groups, grant.scope),
  };
}

/** Why a read came back with nothing, as the tool put it. */
function refusal(result: unknown, fallback: string): string {
  if (isUnavailable(result)) return String((result as { reason?: string }).reason ?? fallback);
  return fallback;
}

/** A Drive file, read now and kept in the project's vault. */
export async function addDriveFile(
  ctx: AppContext,
  llm: Summariser,
  input: { userId: string; projectId: string; fileId: string; google?: ToolContext },
): Promise<{ name: string; added: boolean } | { error: string }> {
  if (!(await projectAlive(ctx, input.projectId))) return GONE;
  const google = input.google ?? (await googleContext(ctx, input.userId));
  const read = await readDriveFile.execute({ fileId: input.fileId }, google);

  let text: string | null;
  try {
    text = textFromDriveRead(read);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Drive would not open that file.' };
  }
  if (!text) return { error: refusal(read, 'There is no readable text in that file.') };

  const title = (read as { name?: string }).name ?? 'Drive file';
  const vault = projectVault(vaultRootOf(ctx), input.userId, input.projectId);
  if (!(await projectAlive(ctx, input.projectId))) return GONE;
  const name = await freeName(vault, uploadNoteName(title) || 'drive-file', input.fileId);
  await vault.write({
    name,
    kind: 'entity',
    source: 'drive',
    description: title,
    externalId: input.fileId,
    body: text,
  });

  const added = await addSource(ctx, llm, {
    userId: input.userId,
    projectId: input.projectId,
    noteName: name,
    noteKind: 'entity',
    owned: true,
    kind: 'drive',
  });
  return added ? { name, added: added.added } : { error: 'That file could not be added.' };
}

/** One email, kept in the project's vault. */
export async function addMail(
  ctx: AppContext,
  llm: Summariser,
  input: { userId: string; projectId: string; messageId: string; google?: ToolContext },
): Promise<{ name: string; added: boolean } | { error: string }> {
  if (!(await projectAlive(ctx, input.projectId))) return GONE;
  const google = input.google ?? (await googleContext(ctx, input.userId));
  const read = await readMail.execute({ messageId: input.messageId }, google);
  if (isUnavailable(read)) return { error: refusal(read, 'That email could not be read.') };

  const mail = read as { subject?: string; from?: string; date?: string; body?: string };
  const subject = mail.subject?.trim() || 'Email';
  const vault = projectVault(vaultRootOf(ctx), input.userId, input.projectId);
  if (!(await projectAlive(ctx, input.projectId))) return GONE;
  const name = await freeName(vault, uploadNoteName(`mail ${subject}`) || 'mail', input.messageId);
  await vault.write({
    name,
    kind: 'entity',
    source: 'gmail',
    description: subject,
    externalId: input.messageId,
    body: `From: ${mail.from ?? ''}\nDate: ${mail.date ?? ''}\nSubject: ${subject}\n\n${mail.body ?? ''}`,
  });

  const added = await addSource(ctx, llm, {
    userId: input.userId,
    projectId: input.projectId,
    noteName: name,
    noteKind: 'entity',
    owned: true,
    kind: 'email',
  });
  return added ? { name, added: added.added } : { error: 'That email could not be added.' };
}

/**
 * A note already in the student's vault, linked rather than copied.
 *
 * Looked for as an entity first, then a written page, then an episode: the
 * order a name is most likely to mean. Linked, so taking it out of the project
 * later removes one row and never the note.
 */
export async function linkVaultNote(
  ctx: AppContext,
  llm: Summariser,
  input: { userId: string; projectId: string; name: string },
): Promise<{ name: string; added: boolean } | { error: string }> {
  const vault = new Vault(vaultRootOf(ctx), input.userId);
  const name = input.name.trim().replace(/^\[\[|\]\]$/g, '');
  if (!/^[a-z0-9-]+$/.test(name)) return { error: `There is no note called "${input.name}".` };

  for (const kind of ['entity', 'document', 'episode'] as const) {
    const note = await vault.read(kind, name);
    if (!note) continue;
    const added = await addSource(ctx, llm, {
      userId: input.userId,
      projectId: input.projectId,
      noteName: name,
      noteKind: kind,
      owned: false,
      kind: sourceKindForNote(note.source),
    });
    return added ? { name, added: added.added } : { error: 'That note could not be added.' };
  }
  return { error: `There is no note called "${input.name}" in the vault.` };
}

/** A context item, read, in the shape both the block and the tools take. */
export interface LoadedSource {
  row: SourceRow;
  note: VaultNote | null;
}

/** Every item in a project's context, oldest first, with its note read. */
export async function loadSources(
  ctx: AppContext,
  userId: string,
  projectId: string,
): Promise<LoadedSource[]> {
  const root = vaultRootOf(ctx);
  const rows = await ctx.db
    .select()
    .from(projectSources)
    .where(eq(projectSources.projectId, projectId))
    .orderBy(projectSources.addedAt);
  return Promise.all(rows.map(async (row) => ({ row, note: await noteOf(root, userId, row) })));
}

/** For the block. An item whose note has gone is left out rather than carried empty. */
export function blockSources(loaded: readonly LoadedSource[]): BlockSource[] {
  return loaded.flatMap(({ row, note }) =>
    note
      ? [
          {
            id: row.id,
            name: row.noteName,
            kind: row.kind,
            summary: row.summary,
            tokens: row.tokens,
            body: note.body,
            untrusted: isUntrusted(note.source),
          },
        ]
      : [],
  );
}

/** For the tools. */
export function projectItems(loaded: readonly LoadedSource[]): ProjectItem[] {
  return blockSources(loaded).map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    summary: source.summary,
    body: source.body ?? '',
    untrusted: source.untrusted ?? false,
  }));
}

/** The project as a turn's tools see it: what is in it, and a way to add to it. */
export class DbProjectAccess implements ProjectAccess {
  constructor(
    private readonly ctx: AppContext,
    private readonly llm: Summariser,
    private readonly userId: string,
    readonly projectId: string,
  ) {}

  async items(): Promise<ProjectItem[]> {
    return projectItems(await loadSources(this.ctx, this.userId, this.projectId));
  }

  async add(ref: ProjectRef): Promise<{ name: string; added: boolean } | { error: string }> {
    const base = { userId: this.userId, projectId: this.projectId };
    if ('note' in ref) return linkVaultNote(this.ctx, this.llm, { ...base, name: ref.note });
    if ('driveFileId' in ref) {
      return addDriveFile(this.ctx, this.llm, { ...base, fileId: ref.driveFileId });
    }
    return addMail(this.ctx, this.llm, { ...base, messageId: ref.gmailMessageId });
  }
}
