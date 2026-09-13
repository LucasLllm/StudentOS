import { z } from 'zod';
import type { ChatMessage, LlmProvider } from '@contexto/llm';
import { VAULT_WRITING } from '../prompts/documents.js';
import { slugForNote } from './slug.js';
import type { Vault } from './vault.js';

/**
 * Putting the student's own words on the same timeline as their school.
 *
 * Without this the vault is two stores pretending to be one: Classroom and the
 * inbox on disk, everything the student ever said in Postgres, and no link
 * between them. The question the vault exists to answer -- Classroom says
 * Friday, the teacher emailed that it moved, and the student said they had not
 * started -- is two thirds of an answer until their side is a node too.
 *
 * Unlike mail, this is not somebody else's text. It is the student's own, so
 * the episode is `source: student` and renders without the warning that wraps
 * anything a stranger wrote. That distinction is the whole reason `source`
 * exists on a note.
 */

export interface ConversationImportDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface ConversationImportOptions {
  vault: Vault;
  /** The exchanges, oldest first, as they were recorded. */
  exchanges: string[];
  /** Stable id for this conversation, so a second pass is a lookup. */
  conversationId: string;
  /** When it happened. */
  occurred: string;
  userId: string;
  /**
   * The agent whose conversation this is.
   *
   * What vault_write wrote during the conversation carries this as its
   * externalId, and the pass is shown those notes so it can decline to record
   * the same thing twice.
   */
  agentId?: string;
}

const extraction = z.object({
  keep: z.boolean(),
  what: z.string().max(400),
  about: z.array(z.string()).max(5).default([]),
  inCourse: z.array(z.string()).max(3).default([]),
});

/**
 * How many of the agent's own earlier writes the pass is shown.
 *
 * Every note vault_write makes for this agent carries its id, across every
 * conversation it has ever had, so the honest list is the recent few,
 * dated, rather than everything, claiming to be this conversation's.
 */
const ALREADY_WRITTEN_LIMIT = 10;

const ASK = [
  'You are reading one conversation between a student and their study agent, and writing',
  'a single episode for ContextoVault, following the rules above.',
  '',
  'This is the student’s own conversation. It is not somebody else’s text and needs no',
  'warning, but it is still a record: write what happened in the third person, never as',
  'advice and never addressed to anyone.',
  '',
  'Reply with JSON only, no prose around it:',
  '{"keep": boolean, "what": string, "about": string[], "inCourse": string[]}',
  '',
  'keep is false when nothing happened to this person. A sum, a spelling, a fact looked',
  'up and forgotten -- none of those are episodes. Keep it when they told you something',
  'about themselves, their work, or how they are getting on with it.',
  '',
  'about and inCourse may only contain names from the list you are given. Omit rather',
  'than guess, and link the specific piece of work as well as the course it belongs to.',
  '',
  'If something that happened is already in the list of what you recorded in recent',
  'conversations, do not record it again. keep is false when that list already covers',
  'everything that happened here.',
].join('\n');

export async function importConversation(
  { llm }: ConversationImportDeps,
  { vault, exchanges, conversationId, occurred, userId, agentId }: ConversationImportOptions,
): Promise<{ written: number }> {
  const existing = await vault.list('episode');

  // Stable id, so a second pass is a lookup -- checked before the model call,
  // because the point is not to pay twice for the same conversation.
  if (existing.some((note) => note.externalId === conversationId)) return { written: 0 };

  // Written by the agent mid-conversation, on the student's say-so.
  const alreadyWritten = agentId
    ? existing
        .filter((note) => note.externalId === agentId)
        .sort((a, b) => (b.occurred ?? '').localeCompare(a.occurred ?? ''))
        .slice(0, ALREADY_WRITTEN_LIMIT)
    : [];

  const entities = await vault.list('entity');
  const allowed = new Set(entities.map((note) => note.name));

  /*
   * Which notes to offer.
   *
   * Narrowed on shared words, then widened one hop through the links the notes
   * already carry -- a student saying "the essay" never says "history", and an
   * episode linked only to the essay loses the course it belongs to.
   */
  const said = new Set(
    exchanges
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4),
  );
  const direct = entities.filter((note) => note.name.split('-').some((part) => said.has(part)));
  const shortlist = new Set(direct.map((note) => note.name));
  for (const note of direct) {
    for (const match of note.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      // Only notes that exist. Offering a target that would then be discarded
      // asks the model to make a choice and silently throws the answer away.
      const target = match[1] as string;
      if (allowed.has(target)) shortlist.add(target);
    }
  }

  const chat: ChatMessage[] = [
    { role: 'system', content: `${VAULT_WRITING.body}\n\n---\n\n${ASK}` },
    {
      role: 'user',
      content:
        `Names you may link to:\n${[...shortlist].join('\n') || '(none)'}\n\n` +
        (alreadyWritten.length > 0
          ? 'Already recorded by you in recent conversations with this student, most recent first:\n' +
            alreadyWritten
              .map((note) => `- ${(note.occurred ?? '').slice(0, 10)}: ${note.description}`)
              .join('\n') +
            '\n\n'
          : '') +
        `The conversation, oldest first:\n\n${exchanges.join('\n\n')}`,
    },
  ];

  // No tools, for the same reason the mail pass has none.
  // Background work the student never waits on; medium is enough for a page
  // and a fifth of the reasoning bill.
  const response = await llm.chat({ effort: 'medium', messages: chat }, { userId });
  const parsed = parse(response.content);
  if (!parsed || !parsed.keep || parsed.what.trim() === '') return { written: 0 };

  const about = parsed.about.filter((name) => allowed.has(name));
  const inCourse = parsed.inCourse.filter((name) => allowed.has(name));

  const base = slugForNote(`${occurred.slice(0, 10)} ${parsed.what}`);
  const taken = new Set(existing.map((note) => note.name));
  let name = base;
  let suffix = 2;
  while (taken.has(name)) name = `${base}-${suffix++}`;

  await vault.write({
    name,
    kind: 'episode',
    source: 'student',
    description: parsed.what.trim().slice(0, 200),
    externalId: conversationId,
    occurred,
    actor: 'The student',
    event: 'conversation',
    body: [
      parsed.what.trim(),
      '',
      ...about.map((entity) => `About [[${entity}]]`),
      ...inCourse.map((course) => `In [[${course}]]`),
      '',
      '## What was said',
      '',
      exchanges.join('\n\n'),
    ]
      .join('\n')
      .trim(),
  });

  return { written: 1 };
}

function parse(content: unknown): z.infer<typeof extraction> | null {
  if (typeof content !== 'string') return null;
  const text = content.trim().replace(/^```(?:json)?\s*/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = extraction.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
