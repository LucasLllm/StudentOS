import { z } from 'zod';

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * The student-authored description of what this agent is for. Becomes part
   * of the system prompt -- students write this in the GUI, never a prompt box
   * labelled "system prompt".
   */
  purpose: z.string(),
  /**
   * What the agent has worked out about this student, in its own words.
   *
   * Written by the summarisation job, never by the student directly -- but
   * shown to them and erasable by them, because a memory a person cannot read
   * or correct is one they have no reason to trust.
   */
  profile: z.string(),
  /** When it was put away, if it was. Null is the ordinary state. */
  archivedAt: z.iso.datetime().nullable(),
  /** When it was pinned, if it is. Ordered by this, so the newest pin leads. */
  pinnedAt: z.iso.datetime().nullable(),
  /** The project this chat belongs to, or null for an ordinary chat. */
  projectId: z.string().nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof agentSchema>;

/**
 * Changing a chat without saying anything to it.
 *
 * Every field is optional and each is sent on its own -- renaming and pinning
 * are separate gestures and a request carrying both would be a rename that
 * silently unpinned. Archive and pin are booleans here rather than the
 * timestamps they become: when it happened is the server's to decide, and a
 * client that could choose would be a client that could lie about it.
 */
export const updateChatSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
});
export type UpdateChatInput = z.infer<typeof updateChatSchema>;

/**
 * Editing what the agent remembers about you.
 *
 * Bounded to the same budget the writer works to, so a student cannot paste in
 * something that would be silently trimmed the moment it is read back.
 */
export const updateProfileSchema = z.object({
  profile: z.string().max(1400),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * Starting a chat.
 *
 * `purpose` is optional, and that is a product change rather than a loosened
 * validator. It used to be the first thing a student wrote -- you described
 * what you wanted before you could talk to anything. A chat starts from a
 * message now, so most agents are created without one, and the system prompt
 * asks for a purpose only when there is one to give (see buildSystemPrompt).
 */
export const createAgentSchema = z.object({
  name: z.string().min(1).max(80),
  purpose: z.string().max(2000).default(''),
  /** Start the chat inside this project. Must be one of the caller's. */
  projectId: z.uuid().optional(),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = createAgentSchema.partial();
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

/** Only roles a student sees. Tool traffic stays inside the turn. */
export const messageRoleSchema = z.enum(['user', 'assistant']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/**
 * A file that went with a message.
 *
 * `name` is the vault note, which is what the turn reads and what makes the
 * file's contents available to the model. `filename` is what the student
 * called it, which is what they will recognise. `image` decides whether the
 * conversation shows a picture or a name.
 */
export const messageAttachmentSchema = z.object({
  name: z.string().min(1).max(120),
  filename: z.string().min(1).max(300),
  image: z.boolean(),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export const messageSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  role: messageRoleSchema,
  content: z.string(),
  toolsUsed: z.array(z.string()),
  /** Skills the agent read before saying this, by name. Empty for the student's. */
  skillsRead: z.array(z.string()).default([]),
  createdAt: z.iso.datetime(),
  /** Files that went with it. Empty for everything the agent says. */
  attachments: z.array(messageAttachmentSchema).default([]),
});
export type Message = z.infer<typeof messageSchema>;

export const sendMessageSchema = z
  .object({
    /*
     * May be empty, but only when something came with it.
     *
     * A picture sent on its own is a real message -- "what is this" is often
     * the photograph and nothing else -- and requiring a character meant
     * padding it with a sentence naming the file, which is what the thumbnail
     * is for.
     */
    content: z.string().max(10_000),
    /**
     * Vault notes attached to this message, by name.
     *
     * Sent separately from the text rather than pasted into it. The transcript
     * keeps what the student typed; the turn gets what they attached. Putting a
     * whole document inside `content` would store it in the conversation for
     * ever and show it to them in their own message bubble.
     */
    attachments: z.array(messageAttachmentSchema).max(10).optional(),
  })
  .refine((body) => body.content.trim() !== '' || (body.attachments?.length ?? 0) > 0, {
    message: 'Say something or attach something.',
    path: ['content'],
  });
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * How a skill entered the agent's repertoire.
 *
 * `builtin`  -- shipped by the platform, same for every student.
 * `learned`  -- accumulated by the agent over time (the Hermes-style loop).
 *               Nothing writes this value yet; see packages/agent/src/skills.
 */
export const skillOriginSchema = z.enum(['builtin', 'learned']);
export type SkillOrigin = z.infer<typeof skillOriginSchema>;

export const skillSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  origin: skillOriginSchema,
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

/**
 * What a running turn is doing at this instant.
 *
 * `thinking` -- waiting on the model. `tool` -- running the named tool.
 * `skill` -- reading the named skill before doing what it covers.
 *
 * Reported live and never persisted: it describes a moment inside a turn, and
 * a moment that has passed is not worth a row. The conversation reads it to
 * name the work on screen rather than spinning a bare "Thinking" through a
 * minute of reading a student's mail. (Which skills a turn read is the one
 * thing that does outlive it -- see `skillsRead` on the message.)
 */
export const agentActivitySchema = z.union([
  z.object({ kind: z.literal('thinking') }),
  z.object({ kind: z.literal('tool'), name: z.string() }),
  z.object({ kind: z.literal('skill'), name: z.string() }),
]);
export type AgentActivity = z.infer<typeof agentActivitySchema>;

/**
 * The parts of an account a student can change themselves.
 *
 * Each field is optional and sent alone, so saving a name does not silently
 * write back an appearance the screen happened to be holding.
 */
export const updateProfileSettingsSchema = z.object({
  /** Empty string clears it, which means "go back to my first name". */
  preferredName: z.string().max(60).optional(),
  appearance: z.enum(['light', 'dark', 'system']).optional(),
});
export type UpdateProfileSettingsInput = z.infer<typeof updateProfileSettingsSchema>;

/** Who the student is, as the settings screen needs them. */
export interface MeProfile {
  name: string;
  email: string;
  /** What the agent calls them: their choice, else their first name. */
  preferredName: string;
  appearance: 'light' | 'dark' | 'system';
  hasAvatar: boolean;
}
