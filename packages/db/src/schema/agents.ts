import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { projects } from './projects.js';

/**
 * A student-built agent.
 *
 * Note the ownership model: agents belong to a student, not to a course or an
 * institution. A school partnership provisions students; it never owns or
 * configures their agents.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Student-authored, in their own words. Feeds the system prompt. */
    purpose: text('purpose').notNull().default(''),
    /**
     * No longer read by a turn. What a student is like now lives on the vault
     * page writeUserDoc writes, one per student rather than one per agent --
     * see the comment on ExchangeCollectorDeps in memory/summarize.ts. This
     * column and profileUpdatedAt below survive only as ProfileStore's
     * watermark, gating when that page is due for a rewrite.
     */
    profile: text('profile').notNull().default(''),
    /**
     * When this agent's memory was last considered -- a watermark, not a
     * change log.
     *
     * It advances on every pass, including the ones that decide nothing is
     * worth keeping, which is most of them. Advancing it only on a change
     * leaves an agent permanently stale and re-read on every wake of the job,
     * for ever. Null until the first pass. The writer reads only the exchanges
     * after it.
     */
    profileUpdatedAt: timestamp('profile_updated_at', { withTimezone: true }),
    /**
     * The student's goal for this conversation, in the model's own words, and
     * where it is against that goal.
     *
     * Nullable: most turns never need one, and it starts out unset rather
     * than an empty list. updatedAtSeq is the transcript seq of the user item
     * of the turn that last wrote it, which is what lets a render compute how
     * many turns have passed since without a separate timestamp.
     */
    plan: jsonb('plan').$type<{
      steps: { step: string; status: string }[];
      updatedAtSeq: number;
    }>(),
    /*
     * Out of the rail, still in the vault.
     *
     * Timestamps rather than booleans, and both nullable: null is the ordinary
     * state, and when it is set the moment it happened is worth having --
     * "archived in June" is the thing a student needs to recognise a chat by
     * in a list of forty they have put away.
     *
     * Archiving deliberately touches nothing but this column. The transcript,
     * the memories and everything the chat taught chats.md stay exactly where
     * they were; it is a filter on one list, not a kind of deletion. Deleting
     * is the other thing, and it is a DELETE.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** Pinned to the top of the rail. Ordered by when, so the newest pin leads. */
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    /**
     * The project this chat belongs to, if any. Such a chat is listed on the
     * project's page rather than in the rail, and goes when the project does.
     */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * The project as this chat was first told it, frozen.
     *
     * The system prompt is cached as a whole, so a project block rebuilt each
     * turn would cost the chat its cache the moment anything was added to the
     * project. It is written on the first turn and replayed byte for byte;
     * what changes afterwards is told in the turn context instead.
     */
    projectContext: text('project_context'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agents_user_id_idx').on(t.userId), index('agents_project_id_idx').on(t.projectId)],
);
