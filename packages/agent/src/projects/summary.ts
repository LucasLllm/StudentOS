import type { LlmProvider } from '@contexto/llm';

/**
 * One line saying what a context item is, for the project's manifest.
 *
 * Written once, when the item is added, and carried on every turn of every
 * chat in the project after -- so it is worth one small call. It is what lets a
 * large project be read on demand: the model decides what to open from these
 * lines alone, and "Uploaded by the student: notes.pdf" gives it nothing to
 * decide with.
 *
 * Never fails the add. A model that is down or says nothing leaves the opening
 * of the text instead, which is worse but still a description.
 */

export const SUMMARY_LIMIT = 160;

/** Enough of a document to say what it is. The whole thing would be paying to summarise a book. */
const READ_CHARS = 6_000;

const PROMPT =
  'Say in one plain line, at most 25 words, what this document is and what it covers, so ' +
  'someone deciding whether to open it knows. Name specifics: subjects, people, dates, ' +
  'numbers. No preamble, no quotation marks. Reply with the line alone.';

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function capped(text: string): string {
  return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`;
}

export async function summariseSource(
  { llm }: { llm: Pick<LlmProvider, 'chat'> },
  { userId, title, body }: { userId: string; title: string; body: string },
): Promise<string> {
  const fallback = capped(oneLine(body));

  try {
    const response = await llm.chat(
      {
        messages: [
          { role: 'system', content: 'You describe documents in one line. You never explain.' },
          {
            role: 'user',
            content: `${PROMPT}\n\nTitle: ${title}\n\n---\n${body.slice(0, READ_CHARS)}`,
          },
        ],
        // Background, one line. Low rather than none so the cap is never why it fails.
        effort: 'low',
        maxOutputTokens: 200,
      },
      { userId },
    );
    const first = oneLine(
      (typeof response.content === 'string' ? response.content : '').trim().split('\n')[0] ?? '',
    ).replace(/^["'“”]+|["'“”]+$/g, '');
    return first ? capped(first) : fallback;
  } catch {
    return fallback;
  }
}
