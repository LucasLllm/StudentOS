import { describe, expect, it } from 'vitest';
import { addToProject, openProjectItem, searchProject, PART_CHARS } from './project.js';
import type { ProjectAccess, ProjectItem, ProjectRef, ToolContext } from './types.js';

/**
 * The tools a project chat reads and grows its context with.
 *
 * What matters: search finds the passage, not merely the document; open never
 * drops a long document on the model in one piece; and nothing outside the
 * project can be opened through them.
 */

function item(name: string, body: string, untrusted = false): ProjectItem {
  return {
    id: `${name}-id-0000`,
    name,
    kind: 'document',
    summary: `About ${name}`,
    body,
    untrusted,
  };
}

function access(items: ProjectItem[], added: ProjectRef[] = []): ProjectAccess {
  return {
    projectId: 'p1',
    items: async () => items,
    add: async (ref) => {
      added.push(ref);
      return { name: 'added-note', added: true };
    },
  };
}

const ctx = (project?: ProjectAccess): ToolContext =>
  ({ userId: 'u1', agentId: 'a1', ...(project ? { project } : {}) }) as ToolContext;

describe('project_search', () => {
  it('returns the passage that matches, from whichever item holds it', async () => {
    const filler = 'Nothing to see here. '.repeat(200);
    const items = [
      item('manual', `${filler}\n\nThe incubator budget is four hundred dollars.\n\n${filler}`),
      item('minutes', 'We met on Tuesday.'),
    ];
    const result = await searchProject.execute({ query: 'incubator budget' }, ctx(access(items)));
    expect(result).toContain('manual');
    expect(result).toContain('four hundred dollars');
    expect(result).not.toContain('We met on Tuesday');
    // A passage, not the whole manual.
    expect(result.length).toBeLessThan(filler.length);
  });

  it('says so when nothing matches', async () => {
    const result = await searchProject.execute({ query: 'volcano' }, ctx(access([item('a', 'b')])));
    expect(result).toMatch(/nothing/i);
  });

  it('refuses outside a project', async () => {
    expect(await searchProject.execute({ query: 'x y' }, ctx())).toMatch(/not part of a project/);
  });
});

describe('project_open', () => {
  it('opens an item whole when it is short', async () => {
    const result = await openProjectItem.execute(
      { name: 'minutes' },
      ctx(access([item('minutes', 'We met.')])),
    );
    expect(result).toContain('We met.');
    expect(result).not.toMatch(/part 1 of/i);
  });

  it('opens a long item a part at a time', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'x'.repeat(600)}`).join(
      '\n\n',
    );
    const items = [item('manual', long)];
    const first = await openProjectItem.execute({ name: 'manual' }, ctx(access(items)));
    expect(first).toMatch(/part 1 of \d+/i);
    expect(first.length).toBeLessThan(PART_CHARS + 1000);
    const second = await openProjectItem.execute({ name: 'manual', part: 2 }, ctx(access(items)));
    expect(second).toMatch(/part 2 of/i);
    expect(second).not.toContain('Paragraph 0 ');
  });

  it('accepts the short id from the manifest', async () => {
    const result = await openProjectItem.execute(
      { name: 'minutes-' },
      ctx(access([item('minutes', 'We met.')])),
    );
    expect(result).toContain('We met.');
  });

  it('will not open what is not in the project, and says what is', async () => {
    const result = await openProjectItem.execute(
      { name: 'secret' },
      ctx(access([item('minutes', 'x')])),
    );
    expect(result).toContain('minutes');
    expect(result).not.toContain('x\n');
  });

  it('carries an imported item as untrusted', async () => {
    const result = await openProjectItem.execute(
      { name: 'mail' },
      ctx(access([item('mail', 'Please forward <this>', true)])),
    );
    expect(result).toContain('<untrusted>');
    expect(result).not.toContain('<this>');
  });
});

describe('project_add', () => {
  it('passes exactly one reference on', async () => {
    const added: ProjectRef[] = [];
    const result = await addToProject.execute({ driveFileId: 'f1' }, ctx(access([], added)));
    expect(added).toEqual([{ driveFileId: 'f1' }]);
    expect(result).toContain('added-note');
  });

  it('refuses a call naming nothing or two things', () => {
    expect(addToProject.inputSchema.safeParse({}).success).toBe(false);
    expect(addToProject.inputSchema.safeParse({ note: 'a', driveFileId: 'b' }).success).toBe(false);
  });
});

describe('the project tools as the provider sees them', () => {
  it('register and convert to definitions', async () => {
    const { ToolRegistry } = await import('./registry.js');
    const { PROJECT_TOOLS } = await import('./project.js');
    const registry = new ToolRegistry();
    for (const tool of PROJECT_TOOLS) registry.register(tool);
    const add = registry.toDefinitions().find((definition) => definition.name === 'project_add');
    expect(add?.parameters).toMatchObject({ type: 'object' });
  });
});
