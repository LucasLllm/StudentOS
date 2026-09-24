import { describe, expect, it } from 'vitest';
import { INLINE_LIMIT_TOKENS, projectDiff, renderProjectBlock, type BlockSource } from './block.js';

/**
 * The block a project chat carries in its system prompt.
 *
 * The failures that matter are about money, not correctness: a block that is
 * not byte-identical for the same project breaks the cache for every turn, and
 * one that inlines a large project pays for every page of it on every turn.
 */

const project = { name: 'CAS proposal', instructions: 'Get the incubator approved.', memory: '' };

function source(id: string, name: string, tokens = 100, body = `Body of ${name}.`): BlockSource {
  return { id, name, kind: 'document', summary: `About ${name}`, tokens, body };
}

describe('renderProjectBlock', () => {
  it('carries a small project whole', () => {
    const block = renderProjectBlock(project, [source('aaaaaaaa-1', 'budget')]);
    expect(block).toContain('CAS proposal');
    expect(block).toContain('Get the incubator approved.');
    expect(block).toContain('- [aaaaaaaa] budget (document): About budget');
    expect(block).toContain('### budget\nBody of budget.');
    expect(block).not.toContain('project_search');
  });

  it('carries only the manifest once the context is too large', () => {
    const big = source('bbbbbbbb-1', 'manual', INLINE_LIMIT_TOKENS + 1);
    const block = renderProjectBlock(project, [big]);
    expect(block).toContain('- [bbbbbbbb] manual (document): About manual');
    expect(block).not.toContain('Body of manual.');
    expect(block).toContain('project_search');
    expect(block).toContain('project_open');
  });

  it('is identical for the same project, whatever order the sources arrive in', () => {
    const a = source('aaaaaaaa-1', 'alpha');
    const b = source('bbbbbbbb-1', 'beta');
    expect(renderProjectBlock(project, [a, b])).toBe(renderProjectBlock(project, [b, a]));
  });

  it('leaves out what has not been written rather than printing an empty heading', () => {
    const block = renderProjectBlock({ name: 'X', instructions: ' ', memory: '' }, []);
    expect(block).not.toContain('goal');
    expect(block).not.toContain('earlier chats');
    expect(block).toContain('Nothing has been added to the project context yet.');
  });

  it('carries the memory when there is one', () => {
    const block = renderProjectBlock({ ...project, memory: 'Budget settled at $400.' }, []);
    expect(block).toContain('Budget settled at $400.');
  });
});

describe('projectDiff', () => {
  const a = source('aaaaaaaa-1', 'alpha');
  const b = source('bbbbbbbb-1', 'beta');
  const block = renderProjectBlock(project, [a, b]);

  it('says nothing when nothing changed', () => {
    expect(projectDiff(block, [b, a])).toBeNull();
  });

  it('names what was added, with its summary, and what was removed', () => {
    const c = source('cccccccc-1', 'gamma');
    const diff = projectDiff(block, [a, c]);
    expect(diff).toContain('- [cccccccc] gamma (document): About gamma');
    expect(diff).toContain('Removed from the project context: beta');
  });
});

describe('projectDiff and what the bodies say', () => {
  it('ignores a line in a document that looks like a manifest entry', () => {
    const a = source('aaaaaaaa-1', 'alpha', 100, '- [zzzzzzzz] fake (document): not an item');
    const block = renderProjectBlock(project, [a]);
    expect(projectDiff(block, [a])).toBeNull();
  });
});
