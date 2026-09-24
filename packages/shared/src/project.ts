import { z } from 'zod';

/**
 * Projects: chats that share a goal, a memory and a context.
 *
 * A project chat is an ordinary chat with a projectId, so the chat shapes in
 * agent.ts cover it; these are the shapes of the project itself and of what
 * its page lists.
 */

/** What a context item is shown as. Decides the card, not how it is read. */
export const sourceKindSchema = z.enum(['document', 'pdf', 'image', 'text', 'drive', 'email']);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string(),
  /** True while the sweep that gathers a new project's context is running. */
  gathering: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectChatSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The last thing said in it, cut to a line. Empty for a chat with nothing said yet. */
  preview: z.string(),
  updatedAt: z.iso.datetime(),
});
export type ProjectChat = z.infer<typeof projectChatSchema>;

export const projectSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: sourceKindSchema,
  summary: z.string(),
  /** The opening of its text, for the card's miniature page. */
  preview: z.string(),
  /** Whether a picture was kept, so the card can show it. */
  image: z.boolean(),
  addedAt: z.iso.datetime(),
});
export type ProjectSource = z.infer<typeof projectSourceSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  instructions: z.string().max(4000).default(''),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  instructions: z.string().max(4000).optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const textSourceSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(200_000),
});
export type TextSourceInput = z.infer<typeof textSourceSchema>;

export const driveSourceSchema = z.object({
  fileIds: z.array(z.string().min(1).max(200)).min(1).max(10),
});
export type DriveSourceInput = z.infer<typeof driveSourceSchema>;
