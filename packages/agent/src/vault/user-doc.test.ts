import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import { USER_DOC_LIMIT, writeUserDoc, readUserDoc } from './user-doc.js';
import { USER_DOC_NAME, writeDocument } from './documents.js';

/**
 * The page read before every reply.
 *
 * A wrong sentence here is worse than a wrong answer: an answer is visible and
 * forgotten, this is invisible and permanent, and it shapes how the agent
 * treats a person on every turn until somebody notices.
 *
 * It is also the index. It is the only thing that says the other pages exist,
 * so a class it fails to name is a class the agent never learns it can open.
 */

const llmSaying = (text: string) => ({
  chat: vi.fn(async (_request: { messages: unknown[]; tools?: unknown }, _ctx?: unknown) => ({
    content: text,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 },
    finishReason: 'stop' as const,
  })),
});

describe('writing the user document', () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-userdoc-'));
    vault = new Vault(root, 'student-1');

    await writeDocument(vault, {
      name: 'class-french',
      description: 'french, as the vault has it',
      body: '# French\n\nTaught by [[mme-rivard]].',
    });
    await writeDocument(vault, {
      name: 'class-chemistry',
      description: 'chemistry, as the vault has it',
      body: '# Chemistry\n\nTaught by [[mr-ali]].',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const freshVault = () => {
    return new Vault(root, `student-fresh-${Date.now()}`);
  };

  const run = (llm: unknown) =>
    writeUserDoc({ llm } as never, { vault, userId: 'u-1', name: 'Lucas' });

  it('writes what the model returned, and reads it back', async () => {
    const page = '# Lucas\n\n## What they study\n\n- [[class-french]] — taught by Mme Rivard';
    expect(await run(llmSaying(page))).toBe(page);
    expect(await readUserDoc(vault)).toBe(page);
  });

  it('reasons at medium, since nobody is waiting on a background write', async () => {
    const llm = llmSaying('# Lucas');
    await run(llm);

    const request = llm.chat.mock.calls[0]?.[0];
    expect(request).toMatchObject({ effort: 'medium' });
  });

  it('keeps the headings and the links the old version stripped', async () => {
    /*
     * The whole point of the change.
     *
     * The paragraph this replaces had every heading, bullet and link taken out
     * on the way to disk -- correct for prose, fatal for a page whose job is to
     * say what else there is to open.
     */
    const page = '# Lucas\n\n## What they study\n\n- [[class-french]]\n- [[class-chemistry]]';
    const written = (await run(llmSaying(page))) as string;

    expect(written).toContain('## What they study');
    expect(written).toContain('[[class-french]]');
  });

  it('shows the writer the pages, not the notes underneath them', async () => {
    await vault.write({
      name: 'oral-presentation',
      kind: 'entity',
      source: 'classroom',
      description: 'Assignment',
      body: 'Oral presentation.\nPart of [[french-a]].',
    });
    const llm = llmSaying('# Lucas');
    await run(llm);

    const sent = JSON.stringify(llm.chat.mock.calls[0]?.[0]);
    expect(sent).toContain('class-french');
    expect(sent).not.toContain('Oral presentation');
  });

  it('sorts subjects from clubs for the writer, rather than leaving it to prose', async () => {
    await writeDocument(vault, {
      name: 'class-model-un',
      description: 'model un',
      body: '# Model UN',
      academic: false,
    });
    const llm = llmSaying('# Lucas');
    await run(llm);

    const sent = JSON.stringify(llm.chat.mock.calls[0]?.[0]);
    expect(sent).toContain('Things they do rather than study');
    expect(sent).toContain('class-model-un');
  });

  it('tells the writer plainly when there are no taught subjects at all', async () => {
    /*
     * Every student, every summer.
     *
     * Last year's classes are dropped and the school has not made next year's
     * yet. An empty heading invites the writer to fill it.
     */
    const empty = new Vault(root, 'student-summer');
    await writeDocument(empty, {
      name: 'class-model-un',
      description: 'model un',
      body: '# Model UN',
      academic: false,
    });

    const llm = llmSaying('# Lucas');
    await writeUserDoc({ llm } as never, { vault: empty, userId: 'u-1', name: 'Lucas' });

    expect(JSON.stringify(llm.chat.mock.calls[0]?.[0])).toContain(
      'no taught subjects recorded right now',
    );
  });

  it('hands over the year rather than leaving it to be read off March’s mail', async () => {
    /*
     * The bug that survived every previous version.
     *
     * Every message on the account says Grade 10, because that is what it said
     * in March. Counting the years since is arithmetic, and is done before the
     * writer ever sees it.
     */
    await vault.write({
      name: 'mail-parents-evening',
      kind: 'episode',
      source: 'gmail',
      description: 'A message',
      occurred: '2026-03-14T09:00:00.000Z',
      event: 'message',
      body: 'Grade 10 parents evening is on Thursday.',
    });

    const llm = llmSaying('# Lucas');
    await run(llm);

    const sent = JSON.stringify(llm.chat.mock.calls[0]?.[0]);
    expect(sent).toMatch(/They are in Grade 1[12]/);
    expect(sent).toContain('academic year(s) have ended since');
  });

  it('remembers whose page it is, so a rewrite need not be told', async () => {
    /*
     * The background job that rewrites this after a student says something new
     * has their exchanges and their vault, and not their name.
     */
    await run(llmSaying('# Lucas'));

    // Add a class to change the sourceHash so the LLM is called again
    await writeDocument(vault, {
      name: 'class-spanish',
      description: 'spanish, as the vault has it',
      body: '# Spanish\n\nTaught by [[sr-torres]].',
    });

    const llm = llmSaying('# Lucas');
    await writeUserDoc({ llm } as never, { vault, userId: 'u-1' });

    expect(JSON.stringify(llm.chat.mock.calls[0]?.[0])).toContain('The student is Lucas.');
  });

  it('tells the writer not to guess a year when nothing says', async () => {
    const llm = llmSaying('# Lucas');
    await run(llm);

    expect(JSON.stringify(llm.chat.mock.calls[0]?.[0])).toContain(
      'do not guess it from a course name',
    );
  });

  it('tells the writer not to name a school nothing has researched', async () => {
    const llm = llmSaying('# Lucas');
    await run(llm);

    expect(JSON.stringify(llm.chat.mock.calls[0]?.[0])).toContain('do not name a school');
  });

  it('offers the school and chats pages when they exist', async () => {
    await writeDocument(vault, { name: 'school', description: 'Their school', body: '# LCC' });
    await writeDocument(vault, {
      name: 'chats',
      description: 'What they said',
      body: 'Short answers.',
    });

    const llm = llmSaying('# Lucas');
    await run(llm);

    const sent = JSON.stringify(llm.chat.mock.calls[0]?.[0]);
    expect(sent).toContain('[[school]]');
    expect(sent).toContain('[[chats]]');
  });

  it('holds it to the budget, cutting whole sections', async () => {
    const long = [
      '# Lucas',
      '',
      'A'.repeat(USER_DOC_LIMIT),
      '',
      '## Later',
      '',
      'B'.repeat(500),
    ].join('\n');
    const written = (await run(llmSaying(long))) as string;

    expect(written.length).toBeLessThanOrEqual(USER_DOC_LIMIT);
    expect(written).not.toContain('## Later');
  });

  it('writes nothing at all for a vault with no classes in it', async () => {
    const empty = new Vault(root, 'student-2');
    const llm = llmSaying('# Nobody');

    expect(await writeUserDoc({ llm } as never, { vault: empty, userId: 'u-2' })).toBeNull();
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('leaves the old page alone when the model returns nothing usable', async () => {
    await run(llmSaying('# Lucas\n\nReal content.'));
    const after = await run(llmSaying('   '));

    expect(after).toContain('Real content');
    expect(await readUserDoc(vault)).toContain('Real content');
  });

  it('does not rewrite a page whose sources have not changed', async () => {
    const testVault = freshVault();
    await writeDocument(testVault, {
      name: 'class-chemistry',
      description: 'Chemistry',
      body: 'Chem.',
      academic: true,
      sourceHash: 'h1',
    });
    const llm = llmSaying('Who they are.');

    await writeUserDoc({ llm } as never, { vault: testVault, userId: 'u', name: 'Lucas' });
    await writeUserDoc({ llm } as never, { vault: testVault, userId: 'u', name: 'Lucas' });
    expect(llm.chat).toHaveBeenCalledTimes(1);

    await writeDocument(testVault, {
      name: 'class-chemistry',
      description: 'Chemistry',
      body: 'Chem, now with labs.',
      academic: true,
      sourceHash: 'h2',
    });
    await writeUserDoc({ llm } as never, { vault: testVault, userId: 'u', name: 'Lucas' });
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });
});

describe('finding the user document wherever it currently lives', () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-userdoc-move-'));
    vault = new Vault(root, 'student-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads the document once one has been written', async () => {
    await writeDocument(vault, {
      name: USER_DOC_NAME,
      description: 'Who this student is',
      body: '# Lucas\n\nIn Grade 11.',
    });

    expect(await readUserDoc(vault)).toContain('Grade 11');
  });

  it('still finds the paragraph a previous version left beside the vault', async () => {
    /*
     * No migration, deliberately.
     *
     * Every vault on disk has user.md at the root. Reading the old place when
     * the new one is empty means an agent keeps its context through the deploy
     * and gains the new page on the next build, rather than losing both.
     */
    await mkdir(vault.directory, { recursive: true });
    await writeFile(join(vault.directory, 'user.md'), 'Lucas is in Grade 10.\n', 'utf8');

    expect(await readUserDoc(vault)).toBe('Lucas is in Grade 10.');
  });

  it('prefers the document to the paragraph when both are there', async () => {
    await mkdir(vault.directory, { recursive: true });
    await writeFile(join(vault.directory, 'user.md'), 'Lucas is in Grade 10.\n', 'utf8');
    await writeDocument(vault, {
      name: USER_DOC_NAME,
      description: 'Who this student is',
      body: 'Lucas is in Grade 11.',
    });

    expect(await readUserDoc(vault)).toBe('Lucas is in Grade 11.');
  });

  it('takes the old paragraph away once it has written the page', async () => {
    await mkdir(vault.directory, { recursive: true });
    await writeFile(join(vault.directory, 'user.md'), 'Lucas is in Grade 10.\n', 'utf8');
    await writeDocument(vault, {
      name: 'class-french',
      description: 'french, as the vault has it',
      body: '# French',
    });

    await writeUserDoc({ llm: llmSaying('# Lucas\n\nIn Grade 11.') } as never, {
      vault,
      userId: 'u-1',
    });

    await rmSync(join(vault.directory, 'docs'), { recursive: true, force: true });
    expect(await readUserDoc(vault)).toBeNull();
  });

  it('is null when neither exists', async () => {
    expect(await readUserDoc(vault)).toBeNull();
  });
});
