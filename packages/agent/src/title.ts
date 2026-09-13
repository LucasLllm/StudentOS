import type { LlmProvider } from '@contexto/llm';

/**
 * What a conversation is called.
 *
 * The rail used to show the first message verbatim, cut off at fifty-six
 * characters. That is a label only in the sense that a photograph of a page is
 * a summary of it: "give me some recipes for potatoes because I have a lot of
 * potatoes" told a student nothing at a glance that "Potato recipes" does not
 * tell them faster.
 *
 * Written from the question rather than from the exchange, and that is a
 * departure from how the big chat products do it -- they wait for the first
 * reply. The reason is latency: this runs beside the turn rather than after
 * it, so it costs the student nothing, and what a conversation is about is
 * almost always settled by the question. Waiting for the answer would buy a
 * marginally better title at the price of the first reply arriving later.
 */

export const TITLE_LIMIT = 56;

/**
 * The rules, and why each one is here.
 *
 * Every clause below exists because a model without it produces something
 * unusable in a list: a sentence, a heading in quotation marks, a title
 * starting "Conversation about", or a cheerful reply agreeing to write one.
 */
const PROMPT = [
  'Write a title for a conversation that begins with the message below.',
  '',
  'Rules:',
  '- Three to five words. Shorter is better.',
  '- Name the subject, not the request. "Potato recipes", not "Asking for recipes".',
  '- No quotation marks, no full stop, no formatting.',
  '- Do not begin with "Chat", "Conversation" or "Help with".',
  '- Sentence case: capitalise the first word and any proper nouns, nothing else.',
  '- Write it in the language the message is written in.',
  '- Reply with the title alone and nothing else.',
].join('\n');

/**
 * Tidy what the model sent back.
 *
 * Kept apart from the call because it is where the failures actually are.
 * Models wrap titles in quotation marks, add a trailing full stop, prefix
 * "Title:", or answer with a sentence -- and every one of those reaches a
 * student's sidebar unless something takes it off.
 */
export function tidyTitle(raw: string): string | null {
  let text = raw.trim().split('\n')[0]?.trim() ?? '';

  // "Title: Potato recipes" -- a habit no instruction reliably stops.
  text = text.replace(/^\s*(?:title|subject)\s*[:\-–]\s*/i, '');
  // Matched pairs only: an apostrophe in "Dad's birthday" is not a quote.
  text = text.replace(/^["'“”«»‘’]+/, '').replace(/["'“”«»‘’]+$/, '');
  text = text.replace(/[.,;:！。]+$/, '');
  text = text.replace(/\s+/g, ' ').trim();

  if (text === '') return null;
  /*
   * A model that answered rather than titled.
   *
   * "Sure, here is a title for your conversation:" is longer than any real
   * title and would sit in the rail as a lie about what the chat is. Better
   * to keep the provisional name than to show that.
   */
  if (text.length > TITLE_LIMIT) return null;
  return text;
}

export interface TitleDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

/**
 * Name a conversation from the message that started it.
 *
 * Returns null rather than throwing, and null means "leave the name alone".
 * A chat that keeps a provisional title because the model was unreachable is
 * a small disappointment; a turn that fails because naming it did is not.
 */
export async function nameConversation(
  { llm }: TitleDeps,
  { question, userId }: { question: string; userId: string },
): Promise<string | null> {
  const asked = question.trim();
  if (asked === '') return null;

  try {
    const response = await llm.chat(
      {
        messages: [
          { role: 'system', content: 'You write short, plain titles. You never explain.' },
          { role: 'user', content: `${PROMPT}\n\n---\n${asked.slice(0, 2000)}` },
        ],
        // A title is five words. Reasoning tokens count against the cap, so
        // low rather than none -- the cap must never be the reason this fails.
        effort: 'low',
        maxOutputTokens: 200,
      },
      { userId },
    );
    return tidyTitle(response.content);
  } catch {
    return null;
  }
}
