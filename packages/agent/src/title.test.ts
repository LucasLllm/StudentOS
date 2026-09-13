import { describe, expect, it } from 'vitest';
import { TITLE_LIMIT, nameConversation, tidyTitle } from './title.js';

/**
 * Naming a conversation, and surviving what a model sends back.
 *
 * The prompt asks for three to five plain words. What arrives is sometimes
 * that, and sometimes a heading in quotation marks, a sentence agreeing to
 * write one, or "Title: Potato recipes" -- and every one of those reaches a
 * student's sidebar unless something takes it off first.
 */

describe('tidying what the model sent', () => {
  it('leaves a good title alone', () => {
    expect(tidyTitle('Potato recipes')).toBe('Potato recipes');
  });

  it('takes off the quotation marks models keep adding', () => {
    expect(tidyTitle('"Potato recipes"')).toBe('Potato recipes');
    expect(tidyTitle('“Potato recipes”')).toBe('Potato recipes');
    expect(tidyTitle("'Potato recipes'")).toBe('Potato recipes');
  });

  it('keeps an apostrophe inside the title', () => {
    // Stripping quotes must not eat the one in "Dad's".
    expect(tidyTitle("Dad's birthday plan")).toBe("Dad's birthday plan");
  });

  it('takes off a label the model prefixed', () => {
    expect(tidyTitle('Title: Potato recipes')).toBe('Potato recipes');
    expect(tidyTitle('Subject - Potato recipes')).toBe('Potato recipes');
  });

  it('takes off a trailing full stop but keeps a question mark', () => {
    expect(tidyTitle('Potato recipes.')).toBe('Potato recipes');
    expect(tidyTitle('What is due Friday?')).toBe('What is due Friday?');
  });

  it('keeps only the first line', () => {
    expect(tidyTitle('Potato recipes\n\nLet me know if you want more!')).toBe('Potato recipes');
  });

  it('collapses the whitespace a model sometimes pads with', () => {
    expect(tidyTitle('  Potato   recipes  ')).toBe('Potato recipes');
  });

  it('refuses a model that answered instead of titling', () => {
    /*
     * Better the provisional name than a sentence in the rail. This is the
     * one failure worth being strict about: it is not a bad title, it is not
     * a title at all.
     */
    const chatty = 'Sure! Here is a short title for your conversation about potato recipes';
    expect(chatty.length).toBeGreaterThan(TITLE_LIMIT);
    expect(tidyTitle(chatty)).toBeNull();
  });

  it('refuses an empty answer', () => {
    expect(tidyTitle('')).toBeNull();
    expect(tidyTitle('   \n  ')).toBeNull();
    expect(tidyTitle('""')).toBeNull();
  });

  it('keeps a title in another language intact', () => {
    expect(tidyTitle('Révision de français')).toBe('Révision de français');
  });
});

describe('naming a conversation', () => {
  const model = (says: string) => ({
    llm: {
      chat: async () => ({ content: says, toolCalls: [], usage: {}, finishReason: 'stop' }),
    },
  });

  it('names it after what was asked', async () => {
    const title = await nameConversation(model('Potato recipes') as never, {
      question: 'give me some recipes for potatoes because I have a lot of potatoes',
      userId: 'u1',
    });
    expect(title).toBe('Potato recipes');
  });

  it('says nothing when there was no question', async () => {
    // A message that is only an attachment names nothing on its own.
    expect(
      await nameConversation(model('X') as never, { question: '  ', userId: 'u1' }),
    ).toBeNull();
  });

  it('leaves the name alone when the model cannot be reached', async () => {
    /*
     * Null means "keep the provisional title". A chat named after its first
     * message is a small disappointment; a turn that failed because naming it
     * did would be a real one.
     */
    const broken = { llm: { chat: async () => Promise.reject(new Error('down')) } };
    const title = await nameConversation(broken as never, { question: 'anything', userId: 'u1' });
    expect(title).toBeNull();
  });

  it('does not send an entire essay to be titled', async () => {
    let sent = '';
    const recording = {
      llm: {
        chat: async ({ messages }: { messages: { role: string; content: string }[] }) => {
          sent = messages.find((m) => m.role === 'user')?.content ?? '';
          return { content: 'Long essay', toolCalls: [], usage: {}, finishReason: 'stop' };
        },
      },
    };

    await nameConversation(recording as never, { question: 'x'.repeat(9000), userId: 'u1' });
    expect(sent.length).toBeLessThan(3000);
  });

  it('asks for low effort under a small token cap', async () => {
    let sent: unknown;
    const recording = {
      llm: {
        chat: async (request: unknown) => {
          sent = request;
          return { content: 'Potato recipes', toolCalls: [], usage: {}, finishReason: 'stop' };
        },
      },
    };

    await nameConversation(recording as never, { question: 'potatoes', userId: 'u1' });
    expect(sent).toMatchObject({ effort: 'low', maxOutputTokens: 200 });
  });
});
