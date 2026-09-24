import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/**
 * A piece of work a student comes back to across many chats.
 *
 * The chats are ordinary agents rows carrying a projectId, so everything a
 * chat already does works unchanged inside one. What a project adds is what
 * those chats share: the goal the student wrote, a memory of what earlier chats
 * settled, and a set of vault notes -- its context.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** "What's the goal?", in the student's words. Given to the model. */
    instructions: text('instructions').notNull().default(''),
    /**
     * What earlier chats in the project established, rewritten whole by the
     * worker once a chat goes quiet. Bounded, so it is a decision about what
     * to keep rather than a log.
     */
    memory: text('memory').notNull().default(''),
    memoryUpdatedAt: timestamp('memory_updated_at', { withTimezone: true }),
    /**
     * When the sweep that gathers a new project's context finished. Null while
     * it is still running, which is what the page shows "Gathering" from.
     */
    gatheredAt: timestamp('gathered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('projects_user_id_idx').on(t.userId)],
);

/**
 * One item of a project's context: a pointer at a vault note.
 *
 * Owned notes live in the project's own vault and go when it goes. The rest
 * are linked from the student's vault -- one row, no copy -- so taking one out
 * of the project deletes the row and nothing else.
 */
export const projectSources = pgTable(
  'project_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    noteName: text('note_name').notNull(),
    noteKind: text('note_kind').notNull().$type<'entity' | 'episode' | 'document'>(),
    owned: boolean('owned').notNull(),
    /** What the card shows it as. Not the note kind: a PDF and a pasted note are both entities. */
    kind: text('kind').notNull().$type<'document' | 'pdf' | 'image' | 'text' | 'drive' | 'email'>(),
    /**
     * One line, written once when the item was added.
     *
     * What the manifest carries for it on every turn of every chat, so it is
     * worth one small model call: an upload's own description is "Uploaded by
     * the student: notes.pdf", which tells a model nothing about when to open it.
     */
    summary: text('summary').notNull().default(''),
    /** Estimated size of the note, which decides whether a project is carried whole. */
    tokens: integer('tokens').notNull().default(0),
    /** Whether an original picture was kept beside the note, for a thumbnail. */
    image: boolean('image').notNull().default(false),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_sources_note_idx').on(t.projectId, t.owned, t.noteKind, t.noteName)],
);
