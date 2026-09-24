import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceKind } from '@contexto/shared';
import { Vault, type NoteSource } from '../vault/vault.js';

/**
 * Where a project keeps what was brought into it.
 *
 * A vault of its own, beside the student's rather than inside it: the
 * student's vault reads only its own entities, episodes and docs directories,
 * so nothing under `projects/` is ever found by vault_search or shown in an
 * ordinary chat. That is the whole of the isolation, and it needs no filter
 * anywhere that could be forgotten.
 */
export function projectVault(root: string, userId: string, projectId: string): Vault {
  // Vault checks the owner id segment; this checks the one above it the same way.
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error(`Unsafe owner id: ${userId}`);
  return new Vault(join(root, userId, 'projects'), projectId);
}

/** Everything a deleted project brought in, gone with it. */
export async function removeProjectVault(root: string, userId: string, projectId: string) {
  await rm(projectVault(root, userId, projectId).directory, { recursive: true, force: true });
}

/** What a file is shown as on its card, from its name and type. */
export function sourceKindFor(filename: string, mimeType: string): SourceKind {
  const name = filename.toLowerCase();
  const type = mimeType.toLowerCase();
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/.test(name)) return 'image';
  if (type.startsWith('text/') || /\.(txt|md|markdown|csv|tsv|json)$/.test(name)) return 'text';
  return 'document';
}

/** What a linked vault note is shown as, from who wrote it. */
export function sourceKindForNote(source: NoteSource): SourceKind {
  if (source === 'gmail') return 'email';
  if (source === 'drive') return 'drive';
  return 'document';
}

/** Sources whose words the student did not write. Same line as vault/render.ts draws. */
export function isUntrusted(source: NoteSource): boolean {
  return source !== 'student' && source !== 'agent';
}
