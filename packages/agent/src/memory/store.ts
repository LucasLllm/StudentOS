import { and, asc, desc, eq, ilike, lt, notInArray, or, sql } from 'drizzle-orm';
import { queryTerms, rankByTermMatches } from './search.js';
import type { Database } from '@contexto/db';
import { agentMemories, agentMemorySummaries } from '@contexto/db';
import type {
  EpisodicMemory,
  MemoryStore,
  MemorySummary,
  RecallOptions,
  RecalledMemory,
  RecordMemoryInput,
} from './types.js';

/*
 * How many exchanges recall returns when nothing more specific is asked for.
 *
 * A turn used to call recall directly to build its own short window of
 * continuity, which made this the entire per-turn variable cost. It no
 * longer does -- the turn now replays the whole chat transcript instead, so
 * recall's only caller left is the worker's exchange collector
 * (memory/summarize.ts), gathering what a student said since it was last
 * looked at. That caller asks for its own limit explicitly; this is just
 * what recall falls back to if a future caller does not.
 */
const DEFAULT_RECALL_LIMIT = 8;
const DEFAULT_SUMMARY_LIMIT = 5;

/**
 * Postgres-backed episodic memory.
 *
 * Recall is recency-ordered, scoped to one agent. No embeddings, no vector
 * index, no extra service -- and for an agent with a few weeks of history that
 * is genuinely the right answer, not a placeholder for one.
 *
 * The upgrade, when recall quality actually degrades, is an `embedding` column
 * on agent_memories and a semantic branch inside `recall()` when
 * `options.query` is set. It stays behind this interface.
 */
export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly db: Database) {}

  async record(input: RecordMemoryInput): Promise<EpisodicMemory> {
    const [row] = await this.db
      .insert(agentMemories)
      .values({
        agentId: input.agentId,
        kind: input.kind,
        content: input.content,
        source: input.source,
        metadata: input.metadata ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning();

    if (!row) throw new Error('Failed to record memory');
    return toEpisodic(row);
  }

  /**
   * Substring match over an agent's own entries, newest first.
   *
   * ILIKE rather than full-text search, deliberately. Postgres text search
   * would need a tsvector column, an index, and a migration; at the volume one
   * student's agent accumulates this scans a few hundred rows on an indexed
   * agent_id and returns in single-digit milliseconds. When that stops being
   * true the signature does not change -- which is the point of it being here
   * rather than inline in a tool.
   */
  async search(agentId: string, query: string, limit = 8): Promise<EpisodicMemory[]> {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];

    /*
     * Any term, not all of them, and the ranking happens after.
     *
     * SQL narrows to plausible rows; rankByTermMatches decides the order,
     * shared with the eval's store so the two cannot disagree. Ranking in SQL
     * would mean rebuilding the same scoring in a second language for no gain
     * at the number of rows one student produces.
     */
    const rows = await this.db
      .select()
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.agentId, agentId),
          or(...terms.map((term) => ilike(agentMemories.content, `%${term}%`))),
        ),
      )
      .orderBy(desc(agentMemories.occurredAt))
      // Over-fetch: SQL cannot tell which of these match the most terms.
      .limit(limit * 5);

    return rankByTermMatches(rows.map(toEpisodic), terms).slice(0, limit);
  }

  async recall(agentId: string, options: RecallOptions = {}): Promise<RecalledMemory> {
    const limit = options.limit ?? DEFAULT_RECALL_LIMIT;

    // TODO(memory): when options.query is set and embeddings exist, run a
    // similarity search here and merge with the recency window.

    const [recent, summaries] = await Promise.all([
      this.db
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.agentId, agentId))
        .orderBy(desc(agentMemories.occurredAt))
        .limit(limit),
      this.db
        .select()
        .from(agentMemorySummaries)
        .where(eq(agentMemorySummaries.agentId, agentId))
        .orderBy(desc(agentMemorySummaries.periodStart))
        .limit(DEFAULT_SUMMARY_LIMIT),
    ]);

    return {
      // Reversed so the model reads them oldest-first, as a narrative.
      recent: recent.map(toEpisodic).reverse(),
      summaries: summaries.map(toSummary),
    };
  }

  async unsummarized(agentId: string, before: Date): Promise<EpisodicMemory[]> {
    // Ids already covered by a summary, so re-running the job is idempotent.
    const covered = this.db
      .select({
        id: sql<string>`jsonb_array_elements_text(${agentMemorySummaries.sourceMemoryIds})`.as(
          'id',
        ),
      })
      .from(agentMemorySummaries)
      .where(eq(agentMemorySummaries.agentId, agentId));

    const rows = await this.db
      .select()
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.agentId, agentId),
          lt(agentMemories.occurredAt, before),
          notInArray(agentMemories.id, covered),
        ),
      )
      .orderBy(asc(agentMemories.occurredAt));

    return rows.map(toEpisodic);
  }

  async saveSummary(input: Omit<MemorySummary, 'id' | 'createdAt'>): Promise<MemorySummary> {
    const [row] = await this.db
      .insert(agentMemorySummaries)
      .values({
        agentId: input.agentId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        summary: input.summary,
        sourceMemoryIds: input.sourceMemoryIds,
      })
      .returning();

    if (!row) throw new Error('Failed to save memory summary');
    return toSummary(row);
  }
}

function toEpisodic(row: typeof agentMemories.$inferSelect): EpisodicMemory {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind as EpisodicMemory['kind'],
    content: row.content,
    source: row.source,
    metadata: row.metadata ?? undefined,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

function toSummary(row: typeof agentMemorySummaries.$inferSelect): MemorySummary {
  return {
    id: row.id,
    agentId: row.agentId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    summary: row.summary,
    sourceMemoryIds: row.sourceMemoryIds,
    createdAt: row.createdAt,
  };
}
