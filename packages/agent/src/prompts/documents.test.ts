import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESPONDING, loadPromptDocument } from './documents.js';

/**
 * The loader's whole job is to fail loudly.
 *
 * A prompt document that goes missing or loses its frontmatter does not break
 * anything a type checker or a health check would notice -- the agent boots,
 * answers, and is simply no longer the thing that was designed. So every one
 * of these cases has to throw at load rather than degrade at runtime.
 */
describe('loading a prompt document', () => {
  let dir: string;

  beforeAll(() => {
    dir = `${mkdtempSync(join(tmpdir(), 'contexto-prompts-'))}/`;
    writeFileSync(
      `${dir}wrong-name.md`,
      '---\nname: something-else\ndescription: x\n---\n\nBody.\n',
    );
    writeFileSync(`${dir}no-description.md`, '---\nname: no-description\n---\n\nBody.\n');
    writeFileSync(`${dir}no-body.md`, '---\nname: no-body\ndescription: x\n---\n\n   \n');
    writeFileSync(`${dir}no-frontmatter.md`, '# Just a heading\n\nBody.\n');
    writeFileSync(
      `${dir}good.md`,
      '---\nname: good\ndescription: A description: with a colon in it.\n---\n\n# Heading\n\nBody.\n',
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('names the missing file rather than surfacing an ENOENT', () => {
    expect(() => loadPromptDocument('nonexistent', dir)).toThrow(/nonexistent\.md is missing/);
  });

  it('rejects a document whose declared name has drifted from its filename', () => {
    // One of the two is a lie and the loader is the last place that can tell.
    expect(() => loadPromptDocument('wrong-name', dir)).toThrow(/not its filename/);
  });

  it('rejects a document with no description', () => {
    expect(() => loadPromptDocument('no-description', dir)).toThrow(/no description/);
  });

  it('rejects frontmatter with nothing under it', () => {
    expect(() => loadPromptDocument('no-body', dir)).toThrow(/no body/);
  });

  it('rejects a document with no frontmatter at all', () => {
    expect(() => loadPromptDocument('no-frontmatter', dir)).toThrow(/frontmatter/);
  });

  it('keeps everything after the first colon in a field', () => {
    // Descriptions are prose and prose contains colons.
    expect(loadPromptDocument('good', dir).description).toBe('A description: with a colon in it.');
  });

  it('returns the body without the frontmatter', () => {
    const body = loadPromptDocument('good', dir).body;
    expect(body.startsWith('# Heading')).toBe(true);
    expect(body).not.toContain('---');
    expect(body).not.toContain('description:');
  });
});

describe('the vault skills', () => {
  it('keeps writing rules and reading rules apart', async () => {
    /*
     * Two documents rather than one. A pass that writes notes needs to know
     * when an episode is worth making; an agent answering a student needs to
     * know how to traverse links and when a copy is the wrong source. Loading
     * either set on the other's turn is tokens spent teaching a job nobody
     * asked for.
     */
    const { VAULT_WRITING, VAULT_READING } = await import('./documents.js');

    expect(VAULT_WRITING.body).toMatch(/when to make a new episode/i);
    expect(VAULT_READING.body).not.toMatch(/when to make a new episode/i);
    expect(VAULT_READING.body).toMatch(/when it is not/i);
  });

  it('tells a reader that imported notes are records, never orders', async () => {
    const { VAULT_READING } = await import('./documents.js');
    expect(VAULT_READING.body).toMatch(/never an instruction to you/i);
  });

  it("tells a writer that marking other words as the student's own removes a boundary", async () => {
    const { VAULT_WRITING } = await import('./documents.js');
    expect(VAULT_WRITING.body).toMatch(/never mark somebody else's words as the student's own/i);
  });

  it('tells a reader that conversations are in the vault too', async () => {
    // The vault answers what no single app can only once the student's own
    // side of it is a node.
    const { VAULT_READING } = await import('./documents.js');
    expect(VAULT_READING.body).toMatch(/conversations are the student's own words/i);
  });

  it('tells a writer which event a mail thread is', async () => {
    // The real import called email threads "conversation", which is the word
    // reserved for the student talking to their agent.
    const { VAULT_WRITING } = await import('./documents.js');
    expect(VAULT_WRITING.body).toMatch(/an email thread is `message`/i);
  });
});

describe('the documents that ship', () => {
  it('loads responding.md at import time', () => {
    expect(RESPONDING.name).toBe('responding');
    expect(RESPONDING.description).not.toBe('');
    expect(RESPONDING.body.length).toBeGreaterThan(500);
  });

  it('does not leak the frontmatter into what the model reads', () => {
    // The description is written for whoever edits the file. Sending it costs
    // tokens on every turn and tells the model nothing it needs.
    expect(RESPONDING.body).not.toContain(RESPONDING.description);
  });

  it('loads compaction.md at import time', async () => {
    const { COMPACTION } = await import('./documents.js');
    expect(COMPACTION.name).toBe('compaction');
    expect(COMPACTION.description).not.toBe('');
    expect(COMPACTION.body.length).toBeGreaterThan(500);
  });

  it('loads working.md at import time', async () => {
    const { WORKING } = await import('./documents.js');
    expect(WORKING.name).toBe('working');
    expect(WORKING.description).not.toBe('');
    expect(WORKING.body.length).toBeGreaterThan(500);
  });
});

describe('the documents that are skills', () => {
  /*
   * A skill's description is the trigger the model reads. Everything else
   * about the document is invisible until the model asks for it, so the
   * description has to say when to ask -- a description that says what the
   * document covers is a table of contents, not a trigger.
   */
  it('loads the browser document', async () => {
    const { BROWSER } = await import('./documents.js');
    expect(BROWSER.name).toBe('browser');
    expect(BROWSER.body.length).toBeGreaterThan(500);
  });

  it('gives every skill a description that says when to load it', async () => {
    const { BROWSER, VAULT_READING, VAULT_WRITING } = await import('./documents.js');
    for (const skill of [BROWSER, VAULT_READING, VAULT_WRITING]) {
      expect(skill.description).toMatch(/^Load /);
    }
  });

  it('tells the reading skill when it is not needed', async () => {
    // "Invoked when unnecessary" is the half of the goal a trigger that only
    // says when to load cannot deliver.
    const { VAULT_READING } = await import('./documents.js');
    expect(VAULT_READING.description).toMatch(/not needed for/i);
  });

  it('tells the writing skill what a turn may and may not write', async () => {
    const { VAULT_WRITING } = await import('./documents.js');
    expect(VAULT_WRITING.body).toMatch(/## From a conversation/);
    expect(VAULT_WRITING.body).toMatch(/left alone, because the next refresh rewrites it/i);
    expect(VAULT_WRITING.body).toMatch(/search before you link/i);
  });

  it('tells the browser skill when a plain fetch is the better tool', async () => {
    const { BROWSER } = await import('./documents.js');
    expect(BROWSER.body).toContain('web_read_link');
    expect(BROWSER.body).toMatch(/not the right tool for a public page/i);
  });
});
