import { and, count, desc, eq, gt, ne } from 'drizzle-orm';
import type { Database } from '@contexto/db';
import { agentTranscriptItems } from '@contexto/db';
import type { ProviderPayload } from '@contexto/llm';
import type {
  AppendTranscriptInput,
  TranscriptItem,
  TranscriptPayload,
  TranscriptStore,
} from './types.js';
import { estimateTokens } from './types.js';

/**
 * Postgres-backed transcript: what the model has said and seen, in order.
 *
 * The store, not the caller, decides how much history to replay: it returns
 * the latest compaction summary (if any) plus everything after the point it
 * covers, so a caller can always send `load(agentId)` straight to the model
 * without re-deriving which rows still matter.
 */
export class PostgresTranscriptStore implements TranscriptStore {
  constructor(private readonly db: Database) {}

  async load(agentId: string): Promise<TranscriptItem[]> {
    const [compactionRow] = await this.db
      .select()
      .from(agentTranscriptItems)
      .where(
        and(eq(agentTranscriptItems.agentId, agentId), eq(agentTranscriptItems.kind, 'compaction')),
      )
      .orderBy(desc(agentTranscriptItems.seq))
      .limit(1);

    const compaction = compactionRow ? toItem(compactionRow) : undefined;
    if (!compaction || compaction.payload.kind !== 'compaction') {
      const rows = await this.db
        .select()
        .from(agentTranscriptItems)
        .where(eq(agentTranscriptItems.agentId, agentId))
        .orderBy(agentTranscriptItems.seq);
      return rows.map(toItem);
    }

    const coversThroughSeq = compaction.payload.coversThroughSeq;
    const rows = await this.db
      .select()
      .from(agentTranscriptItems)
      .where(
        and(
          eq(agentTranscriptItems.agentId, agentId),
          gt(agentTranscriptItems.seq, coversThroughSeq),
          ne(agentTranscriptItems.kind, 'compaction'),
        ),
      )
      .orderBy(agentTranscriptItems.seq);

    return [compaction, ...rows.map(toItem)];
  }

  async append(items: AppendTranscriptInput[]): Promise<TranscriptItem[]> {
    // drizzle's insert builder rejects values([]); nothing to store either way.
    if (items.length === 0) return [];

    const rows = await this.db.transaction((tx) =>
      tx
        .insert(agentTranscriptItems)
        .values(
          items.map((item) => ({
            agentId: item.agentId,
            turnId: item.turnId,
            kind: item.payload.kind,
            payload: item.payload,
            providerPayload: item.providerPayload ?? null,
            tokenEstimate: estimateTokens(item.payload, item.providerPayload),
          })),
        )
        .returning(),
    );

    return rows.map(toItem).sort((a, b) => a.seq - b.seq);
  }

  async count(agentId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(agentTranscriptItems)
      .where(eq(agentTranscriptItems.agentId, agentId));

    return row?.count ?? 0;
  }
}

function toItem(row: typeof agentTranscriptItems.$inferSelect): TranscriptItem {
  return {
    id: row.id,
    agentId: row.agentId,
    seq: Number(row.seq),
    turnId: row.turnId,
    payload: row.payload as TranscriptPayload,
    ...(row.providerPayload ? { providerPayload: row.providerPayload as ProviderPayload } : {}),
    tokenEstimate: row.tokenEstimate,
    createdAt: row.createdAt,
  };
}
