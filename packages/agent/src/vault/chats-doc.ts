import type { LlmProvider } from '@contexto/llm';
import { CHATS_DOC } from '../prompts/documents.js';
import {
  CHATS_DOC_LIMIT,
  CHATS_DOC_NAME,
  capDocument,
  readDocument,
  writeDocument,
} from './documents.js';

import { retrying } from './retry.js';
import type { Vault } from './vault.js';

/**
 * What is kept from a student's conversations, once they are over.
 *
 * Replaces the conversation profile, and differs from it in the one way that
 * matters: the profile belonged to an agent, so a student with three agents had
 * to tell each of them separately that they read on a phone and cannot take
 * long answers. This page belongs to the student. Said once, known everywhere.
 *
 * Rewritten whole rather than appended to, because a bounded page is what
 * forces the decision about what to drop -- and a page that only grows ends up
 * describing somebody who was dreading a presentation last March.
 *
 * Runs in the background after a conversation has gone quiet, not during one.
 * A pass judging a conversation that is still happening judges half of it, and
 * the cost lands on a student waiting for a reply.
 */

export interface ChatsDocDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface ChatsDocOptions {
  vault: Vault;
  /** The exchanges since this last ran, oldest first. */
  exchanges: string[];
  userId: string;
  /**
   * What was known about them before this page existed.
   *
   * The migration, and there is no SQL in it. Every student already has
   * per-agent profiles; handing them to the first write means nobody loses what
   * was learned about them on the day this ships. Ignored once a page exists.
   */
  knownBefore?: string[];
}

/** What a pass says when a conversation taught it nothing worth keeping. */
const NOTHING = 'UNCHANGED';

/**
 * What the page says before a student has said anything durable.
 *
 * The page exists from the moment a vault does, because a vault is meant to be
 * a folder somebody can open and see the whole shape of -- and a page that
 * appears only once somebody has confided something is a hole in that picture
 * for everybody new.
 *
 * Seeding it is only safe while the writer is told the file is empty. A
 * placeholder handed over as though it were the document is exactly how this
 * product once saved "(empty, nothing known yet)" as what an agent knew about a
 * person: from where the model sat, the placeholder WAS the document.
 */
export const NOTHING_KEPT_YET =
  'Nothing has been kept from their conversations yet. This fills in as they talk.';

/** Make the page if it is missing, so the vault is never short one. */
export async function ensureChatsDoc(vault: Vault): Promise<void> {
  const existing = await readDocument(vault, CHATS_DOC_NAME);
  if (existing) return;

  await writeDocument(vault, {
    name: CHATS_DOC_NAME,
    description: 'What this student has told you, across every conversation',
    body: NOTHING_KEPT_YET,
  });
}

/**
 * A model narrating an absence is not a page about a student.
 *
 * This failure reached production once already, on the pass this replaces: it
 * was shown a placeholder where the document went and asked for it back
 * untouched if nothing was worth keeping, and the first real run returned the
 * placeholder, which was saved as what the agent knew about a person. There is
 * no placeholder here any more, and this is the belt to that pair of braces --
 * models describe an absence a dozen ways and any of them stored here is read
 * on every turn afterwards.
 */
const DESCRIBES_NOTHING =
  /^\(?\s*(?:unchanged|empty|none|nothing|no (?:durable|new|page|document|facts?|information|preferences?))\b/i;

export async function updateChatsDoc(
  { llm }: ChatsDocDeps,
  { vault, exchanges, userId, knownBefore }: ChatsDocOptions,
): Promise<{ changed: boolean }> {
  if (exchanges.length === 0) return { changed: false };

  const existing = await readDocument(vault, CHATS_DOC_NAME);
  /*
   * The placeholder is not the page.
   *
   * Shown in the slot where the document goes, it comes back untouched and gets
   * saved as what is known about a person. There is nothing to hand over until
   * somebody has actually said something.
   */
  const held = existing?.body?.trim() === NOTHING_KEPT_YET ? '' : (existing?.body?.trim() ?? '');
  const standing = held || (knownBefore ?? []).join('\n\n').trim();

  const answer = await retrying(() =>
    llm.chat(
      {
        // Background work the student never waits on; medium is enough for a page
        // and a fifth of the reasoning bill.
        effort: 'medium',
        messages: [
          { role: 'system', content: CHATS_DOC.body },
          {
            role: 'user',
            content: [
              standing === ''
                ? 'Nothing has been kept about this student yet.'
                : `The page as it stands:\n\n${standing}`,
              '',
              'What has been said since, oldest first:',
              '',
              /*
               * Not through renderNotes.
               *
               * These are the student's own words to their own agent. They are
               * the one input in this system that carries no warning, which is
               * the whole reason a note records who wrote it.
               */
              exchanges.join('\n\n'),
              '',
              `The page may be at most ${CHATS_DOC_LIMIT} characters.`,
            ].join('\n'),
          },
        ],
      },
      { userId },
    ),
  );

  const said = typeof answer.content === 'string' ? answer.content.trim() : '';
  if (said === '' || said.toUpperCase().startsWith(NOTHING)) return { changed: false };
  if (DESCRIBES_NOTHING.test(said)) return { changed: false };

  const body = capDocument(said, CHATS_DOC_LIMIT);
  if (body === '') return { changed: false };

  /*
   * The page handed back as it stands is not a change.
   *
   * Rewriting it to identical bytes costs a write and reports a change that did
   * not happen, which is the signal the caller uses to decide whether anything
   * downstream needs redoing.
   */
  if (body === standing) return { changed: false };

  await writeDocument(vault, {
    name: CHATS_DOC_NAME,
    description: 'What this student has told you, across every conversation',
    body,
  });

  return { changed: true };
}

export interface ForgetChatOptions {
  vault: Vault;
  /** Everything the deleted conversation said, oldest first. */
  exchanges: string[];
  userId: string;
}

/**
 * The most of a deleted conversation the writer is shown, in characters.
 *
 * The page was written from at most forty exchanges per pass, but over a long
 * chat's life a fact could have come from any of them, so the whole thing is
 * the honest input. Bounded because a chat that ran for a term is a prompt that
 * does not fit; the newest exchanges are the ones kept, since a page rewritten
 * whole each pass is most shaped by what was said last.
 */
const FORGET_BUDGET = 150_000;

/**
 * Take a deleted conversation back off the page.
 *
 * The page has no memory of which conversation taught it what -- it is
 * rewritten whole, and a fact said in one chat is simply on the page after.
 * That is right while the chat exists and wrong the moment a student deletes
 * it: the transcript and the memories go, and what they taught has to go too,
 * or deleting a chat quietly leaves the part of it that is read on every turn.
 *
 * So the writer is shown the page and the conversation, and asked for the page
 * as it would stand had that conversation never happened. Judgement, not
 * bookkeeping, because bookkeeping is what the page does not have.
 *
 * Unlike the writer this may leave nothing behind. There, a model narrating an
 * absence must never be saved as the page; here, an absence is the truthful
 * outcome of deleting the only conversation that taught anything, and the page
 * goes back to the words a new vault uses.
 */
export async function forgetChatInChatsDoc(
  { llm }: ChatsDocDeps,
  { vault, exchanges, userId }: ForgetChatOptions,
): Promise<{ changed: boolean }> {
  if (exchanges.length === 0) return { changed: false };

  const existing = await readDocument(vault, CHATS_DOC_NAME);
  const standing = existing?.body?.trim() ?? '';
  if (standing === '' || standing === NOTHING_KEPT_YET) return { changed: false };

  const shown: string[] = [];
  let size = 0;
  for (const exchange of [...exchanges].reverse()) {
    size += exchange.length;
    if (size > FORGET_BUDGET && shown.length > 0) break;
    shown.unshift(exchange);
  }

  const answer = await retrying(() =>
    llm.chat(
      {
        effort: 'medium',
        messages: [
          { role: 'system', content: CHATS_DOC.body },
          {
            role: 'user',
            content: [
              `The page as it stands:\n\n${standing}`,
              '',
              'The student has deleted one of their conversations. This is it, oldest first:',
              '',
              shown.join('\n\n'),
              '',
              'Write the page again as it would stand if that conversation had never happened.',
              'Take off whatever the page learned from it. Leave everything else exactly as it is.',
              'If nothing on the page came from this conversation, reply with the single word',
              '`UNCHANGED`. If nothing would be left on the page, reply with the single word',
              '`NOTHING`.',
              '',
              `The page may be at most ${CHATS_DOC_LIMIT} characters.`,
            ].join('\n'),
          },
        ],
      },
      { userId },
    ),
  );

  const said = typeof answer.content === 'string' ? answer.content.trim() : '';
  if (said === '' || said.toUpperCase().startsWith(NOTHING)) return { changed: false };

  const body = DESCRIBES_NOTHING.test(said) ? NOTHING_KEPT_YET : capDocument(said, CHATS_DOC_LIMIT);
  if (body === '' || body === standing) return { changed: false };

  await writeDocument(vault, {
    name: CHATS_DOC_NAME,
    description: 'What this student has told you, across every conversation',
    body,
  });

  return { changed: true };
}
