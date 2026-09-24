import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import { readFileContents } from './files.js';

/**
 * Reading what is actually inside the files.
 *
 * The vault knows a worksheet exists, which course it belongs to and which
 * assignment it was attached to -- and nothing whatsoever about what it says.
 * A student asking "what do I need for the titration writeup" gets told a file
 * called "Titration method.pdf" exists, which they could have seen themselves.
 *
 * This is the only part of the bootstrap that is expensive per item, so
 * everything here is about spending that money once: never re-reading a file,
 * never retrying one that cannot be read, and stopping at a limit so the cost
 * is paid over several runs rather than all at once.
 */

const summary = (text: string, inCourse: string[] = []) => ({
  // Typed parameters so a test can inspect what the pass was actually sent --
  // the toolless check reads the request rather than trusting the code.
  chat: vi.fn(async (_request: { messages: unknown[]; tools?: unknown }, _ctx?: unknown) => ({
    content: JSON.stringify({ what: text, kind: 'worksheet', inCourse }),
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop' as const,
  })),
});

describe('reading the files in the vault', () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-files-'));
    vault = new Vault(root, 'student-1');

    await vault.write({
      name: 'titration-method',
      kind: 'entity',
      source: 'classroom',
      description: 'File',
      externalId: 'drive-1',
      body: 'Titration method.pdf.\n\nPart of [[chemistry]].',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // `unknown` for the deps, as the mail tests do: a fake chat cannot satisfy
  // the provider's full signature, and pinning it here would be a test that
  // measures vitest's Mock type rather than this pass.
  const run = (deps: unknown, limit?: number) =>
    readFileContents(deps as never, { vault, userId: 'u1', ...(limit ? { limit } : {}) });

  it('puts what a file says into its note', async () => {
    const result = await run({
      llm: summary('Step by step method for the titration, including the safety rules.'),
      read: async () => 'Fill the burette to 0.00 cm3. Wear goggles at all times.',
    });

    expect(result.read).toBe(1);
    const note = await vault.read('entity', 'titration-method');
    expect(note?.body).toContain('safety rules');
    // The links it already had must survive: the summary is added to the note,
    // not written over it.
    expect(note?.body).toContain('[[chemistry]]');
  });

  it('reports how far through it is, as it goes', async () => {
    /*
     * Reading a vault's files takes hours -- 1,810 of them at four seconds
     * each on a real account. A student who pressed a button deserves to see
     * that moving rather than a spinner, and a note count climbing does not
     * say how much is left.
     */
    for (const n of [2, 3, 4]) {
      await vault.write({
        name: `file-${n}`,
        kind: 'entity',
        source: 'classroom',
        description: 'File',
        externalId: `drive-${n}`,
        body: `File ${n}.`,
      });
    }

    const seen: Array<{ done: number; total: number }> = [];
    await readFileContents(
      {
        llm: summary('Something.'),
        read: async () => 'text',
        onProgress: (done: number, total: number) => seen.push({ done, total }),
      } as never,
      { vault, userId: 'u1' },
    );

    expect(seen).toHaveLength(4);
    expect(seen.map((s) => s.done)).toEqual([1, 2, 3, 4]);
    // The total is the whole job, so a bar can be drawn against it.
    expect(new Set(seen.map((s) => s.total))).toEqual(new Set([4]));
  });

  it('takes a blank document out rather than filing it', async () => {
    // Opened, and empty. A note about nothing is a dot that answers searches with a blank.
    const result = await run({ llm: summary('Something.'), read: async () => '   \n' });

    expect(result.blank).toHaveLength(1);
    expect((await vault.list('entity')).some((note) => note.description === 'File')).toBe(false);
  });

  it('counts a file it could not read towards progress too', async () => {
    // Otherwise a vault of unreadable video stalls at zero and looks stuck.
    const seen: number[] = [];
    await readFileContents(
      {
        llm: summary('unused'),
        read: async () => null,
        onProgress: (done: number) => seen.push(done),
      } as never,
      { vault, userId: 'u1' },
    );

    expect(seen).toEqual([1]);
  });

  it('never reads the same file twice', async () => {
    // The expensive half of the whole vault. A pass that re-reads what it has
    // already read costs the same as the first pass, for nothing.
    const deps = {
      llm: summary('A method.'),
      read: vi.fn(async () => 'text'),
    };
    await run(deps);
    const second = await run(deps);

    expect(second.read).toBe(0);
    expect(deps.read).toHaveBeenCalledTimes(1);
  });

  it('stops at the limit, so the cost is spread over runs', async () => {
    for (const n of [2, 3, 4]) {
      await vault.write({
        name: `file-${n}`,
        kind: 'entity',
        source: 'classroom',
        description: 'File',
        externalId: `drive-${n}`,
        body: `File ${n}.`,
      });
    }

    const result = await run({ llm: summary('Something.'), read: async () => 'text' }, 2);
    expect(result.read).toBe(2);
  });

  it('still files an unreadable file under a course, from its name alone', async () => {
    /*
     * A photographed worksheet, a rehearsal video, a CAD part -- none of them
     * hold text, and all of them still belong to a subject. "MHS_Trig_WP_Num1"
     * is trigonometry whether or not anything can read inside it, and left
     * unlinked it is a loose dot in a vault where being connected is the whole
     * point.
     *
     * The title is enough, and asking about a title costs a fraction of what
     * asking about a document costs.
     */
    await vault.write({
      name: 'grade-10-math',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Grade 10 Math.',
    });
    await vault.write({
      name: 'mhs-trig-wp-num1-jpg',
      kind: 'entity',
      source: 'drive',
      description: 'File',
      externalId: 'img-1',
      body: 'MHS_Trig_WP_Num1.JPG.',
    });

    const result = await run({
      llm: summary('unused', ['grade-10-math']),
      read: async () => null,
    });

    expect(result.unreadable).toBe(2);
    const note = await vault.read('entity', 'mhs-trig-wp-num1-jpg');
    expect(note?.body).toContain('Part of [[grade-10-math]]');
    expect(note?.body).toContain('Nothing readable');
  });

  it('does not ask about a title when there are no courses to choose from', async () => {
    // Nothing to link to, so nothing to pay for.
    const llm = {
      chat: vi.fn(async () => ({
        content: '{}',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop' as const,
      })),
    };
    await run({ llm, read: async () => null });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('gives up on a file it cannot read, and does not come back to it', async () => {
    /*
     * A scanned photo with no text, a file the student lost access to, a
     * format nothing can open. Without a record of having tried, every run
     * for the rest of the year tries all of them again.
     */
    const deps = { llm: summary('unused'), read: vi.fn(async () => null) };
    const first = await run(deps);
    expect(first.unreadable).toBe(1);

    const second = await run(deps);
    expect(second.read).toBe(0);
    expect(second.unreadable).toBe(0);
    expect(deps.read).toHaveBeenCalledTimes(1);
  });

  it('files a loose Drive file under the course it turns out to be about', async () => {
    /*
     * A file out of the student's own Drive arrives with a name and nothing
     * else -- on a real account 459 of 469 of them resolve to no folder at
     * all. The pass that reads it has the file open anyway, so deciding which
     * course it belongs to costs nothing extra, and it is the difference
     * between a loose dot and something on the right thread.
     */
    await vault.write({
      name: 'grade-10-math',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Grade 10 Math.',
    });
    await vault.write({
      name: 'june-exam-study-guide',
      kind: 'entity',
      source: 'drive',
      description: 'File',
      externalId: 'drive-9',
      body: 'June Exam Study Guide.\n\nYours -- you made this.',
    });

    await run({
      llm: summary('Revision questions on quadratics and trigonometry.', ['grade-10-math']),
      read: async () => 'Solve for x. Find the missing angle.',
    });

    expect((await vault.read('entity', 'june-exam-study-guide'))?.body).toContain(
      'Part of [[grade-10-math]]',
    );
  });

  it('will not invent a course that does not exist', async () => {
    // The same rule the mail pass follows: a link may only point at a note
    // that is already there, so an edge always lands somewhere real.
    await run({
      llm: summary('Something.', ['a-course-nobody-has']),
      read: async () => 'text',
    });

    expect((await vault.read('entity', 'titration-method'))?.body).not.toContain('[[a-course');
  });

  it('does not file a note under a course it is already filed under', async () => {
    await vault.write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry.',
    });

    await run({
      llm: summary('A method.', ['chemistry']),
      read: async () => 'text',
    });

    const body = (await vault.read('entity', 'titration-method'))?.body ?? '';
    expect(body.match(/\[\[chemistry\]\]/g)).toHaveLength(1);
  });

  it('leaves everything that is not a file alone', async () => {
    await vault.write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry.',
    });

    const deps = { llm: summary('x'), read: vi.fn(async () => 'text') };
    await run(deps);
    expect((await vault.read('entity', 'chemistry'))?.body).toBe('Chemistry.');
  });

  it('tries again when the model is rate limited', async () => {
    /*
     * A real run of 512 files failed 196 of them -- 38 per cent. Retrying 20
     * of those by hand, 16 worked first time, so almost none of it was about
     * the files: it was a per-minute token limit, and a reader with no retry
     * turns "come back shortly" into a permanent failure.
     *
     * The mail pass already had this. It was written there, for this exact
     * reason, and never carried across -- which is why both now share one
     * implementation instead of two that drift.
     */
    let call = 0;
    const llm = {
      chat: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('429 Rate limit reached for gpt-6-luna');
        return {
          content: JSON.stringify({ what: 'A method.', kind: 'worksheet', inCourse: [] }),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop' as const,
        };
      }),
    };

    const result = await run({ llm, read: async () => 'text' });
    expect(result.read).toBe(1);
    expect(call).toBe(2);
  });

  it('tries again when reading the file itself fails transiently', async () => {
    // Drive throws too -- a detached buffer, a stalled download. Same answer.
    let call = 0;
    const result = await run({
      llm: summary('Fine.'),
      read: async () => {
        call += 1;
        if (call === 1) throw new Error('503 Service Unavailable');
        return 'text';
      },
    });

    expect(result.read).toBe(1);
  });

  it('does not retry a file the model genuinely cannot answer for', async () => {
    const llm = {
      chat: vi.fn(async () => {
        throw new Error('400 context length exceeded');
      }),
    };
    const result = await run({ llm, read: async () => 'text' });

    expect(result.failed).toBe(1);
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('trims an answer that runs long instead of throwing the file away', async () => {
    /*
     * The caps were rejecting rather than trimming, and that failed the files
     * it should have served best. Measured on a real vault: of twelve stuck
     * files, eight were refused for a summary of 327 to 409 characters against
     * a 300 cap, or a kind of 44 against 40 -- and they were the debate
     * briefs, the Model UN position papers, the assessment rubrics. The more
     * a document actually contained, the longer its summary, and the likelier
     * it was to be discarded whole.
     *
     * The cap is worth keeping: it is what stops a hostile file from writing
     * paragraphs into a note through a field meant to hold a sentence. But it
     * is enforced just as well by trimming, and trimming costs a clause where
     * refusing costs the file.
     */
    const long = 'A very thorough description. '.repeat(30);
    const result = await run({
      llm: {
        chat: vi.fn(async () => ({
          content: JSON.stringify({
            what: long,
            kind: 'Personal Project planning guide and checklist',
            inCourse: [],
          }),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop' as const,
        })),
      },
      read: async () => 'text',
    });

    expect(result.read).toBe(1);
    expect(result.failed).toBe(0);

    const note = await vault.read('entity', 'titration-method');
    expect(note?.body).toContain('A very thorough description.');
    // Trimmed, not stored whole -- the bound is the point of the bound.
    const summaryText = note!.body.split('## What is in it')[1] ?? '';
    expect(summaryText.length).toBeLessThan(400);
  });

  it('takes only the courses it is allowed, when the model names too many', async () => {
    await vault.write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry.',
    });
    await vault.write({
      name: 'physics',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Physics.',
    });
    await vault.write({
      name: 'biology',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Biology.',
    });

    const result = await run({
      llm: summary('A method.', ['chemistry', 'physics', 'biology']),
      read: async () => 'text',
    });

    expect(result.read).toBe(1);
    const body = (await vault.read('entity', 'titration-method'))?.body ?? '';
    expect((body.match(/Part of \[\[/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  it('says why a file failed, rather than only counting it', async () => {
    /*
     * The reason was being caught and dropped, so three separate passes over a
     * real vault reported nothing but a number -- 196 failed, then 77, then
     * 21 -- and every diagnosis of them was guesswork run from a throwaway
     * script. Twice that guess was wrong.
     *
     * A count says something went wrong. Only the reason says what to do.
     */
    const result = await run({
      llm: summary('unused'),
      read: async () => {
        throw new Error('403 The caller does not have permission');
      },
    });

    expect(result.failed).toBe(1);
    expect(result.reasons[0]).toMatch(/403/);
    expect(result.reasons[0]).toContain('titration-method');
  });

  it('carries on when one file fails', async () => {
    await vault.write({
      name: 'file-2',
      kind: 'entity',
      source: 'classroom',
      description: 'File',
      externalId: 'drive-2',
      body: 'File 2.',
    });

    const result = await run({
      llm: summary('Fine.'),
      read: async (id: string) => {
        if (id === 'drive-1') throw new Error('Drive is having a moment');
        return 'text';
      },
    });

    expect(result.read).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('reads only the files it is pointed at', async () => {
    await vault.write({
      name: 'a',
      kind: 'entity',
      source: 'drive',
      description: 'File',
      externalId: 'fa',
      body: 'a.',
    });
    await vault.write({
      name: 'b',
      kind: 'entity',
      source: 'drive',
      description: 'File',
      externalId: 'fb',
      body: 'b.',
    });
    const read = vi.fn(async () => 'Some words about b.');
    const llm = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ what: 'About b.', kind: 'notes', inCourse: [] }),
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
        finishReason: 'stop' as const,
      })),
    };
    const result = await readFileContents(
      { llm, read },
      { vault, userId: 'u', only: new Set(['fb']) },
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('fb');
    expect(result.remaining).toBe(0);
  });
});
