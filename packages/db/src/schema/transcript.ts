import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/**
 * What the model sees of a conversation: every item a turn produced, in order.
 *
 * Distinct from agent_messages, which is what the STUDENT sees -- their words
 * and the replies -- and from agent_memories, which is a curated, lossy log.
 * This one is the model's working memory: the assistant's raw output items
 * (reasoning included), each tool result, and later the summaries that stand
 * in for what was compacted away. Append-only: rows are never rewritten, so
 * the prefix the provider caches is byte-identical from one turn to the next.
 */
export const agentTranscriptItems = pgTable(
  'agent_transcript_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Global and monotonic; only the order within one agent matters. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    /** One runAgentTurn == one turn id. Nothing ever cuts inside a turn. */
    turnId: uuid('turn_id').notNull(),
    /** 'user' | 'assistant' | 'tool_result' | 'compaction' | 'tool_results_cleared' */
    kind: text('kind').notNull(),
    /** The provider-neutral item; shape per kind lives in packages/agent. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** The provider's own output items for an assistant item, replayed verbatim. */
    providerPayload: jsonb('provider_payload').$type<{ format: string; items: unknown[] }>(),
    /** chars / 4 at write time, so a budget check never has to load payloads twice. */
    tokenEstimate: integer('token_estimate').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_transcript_items_agent_seq_idx').on(t.agentId, t.seq)],
);
