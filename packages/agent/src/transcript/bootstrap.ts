import type { TranscriptPayload } from './types.js';

/**
 * Seeds a transcript for a chat that predates the transcript table.
 *
 * Those chats only ever stored plain `{ role, content }` rows, so this is a
 * one-way door: the model gets its words back, but not tool results or
 * reasoning, which were never stored. That is accepted.
 */
export const BOOTSTRAP_MESSAGE_LIMIT = 40;

export function bootstrapItems(
  rows: { role: string; content: string }[],
  limit = BOOTSTRAP_MESSAGE_LIMIT,
): TranscriptPayload[] {
  const items: TranscriptPayload[] = [];
  for (const row of rows.slice(-limit)) {
    if (row.role === 'user') {
      items.push({ kind: 'user', content: row.content });
    } else if (row.role === 'assistant') {
      items.push({ kind: 'assistant', content: row.content });
    }
  }
  return items;
}
