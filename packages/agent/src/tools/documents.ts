import { z } from 'zod';
import { listDocuments, readDocument } from '../vault/documents.js';
import { renderNotes } from '../vault/render.js';
import type { Tool } from './types.js';

/**
 * Opening one of the documents written about a student.
 *
 * The counterpart to vault_search, and deliberately a separate tool. Search is
 * how you get at the evidence: thousands of notes, ranked on words, a handful
 * returned. This is how you get at what was written from it -- a page per
 * class, one about the school, one about what they have told us -- which are
 * not searched for but named.
 *
 * There is no list mode, because there is no need for one. The document the
 * agent is already carrying names the others in [[double brackets]], so the
 * index arrives free on every turn. A wrong name answers with what exists,
 * which covers the rest. Naming them in this description instead would make it
 * differ per student, and the tool definitions are part of the cached prefix.
 */

const inputSchema = z.object({
  name: z
    .string()
    .max(80)
    .describe('The document to open, as written inside the [[double brackets]].'),
});

export const openVaultDocument: Tool<z.infer<typeof inputSchema>, string> = {
  id: 'vault_open',
  description:
    'Open one of the pages written about this student: a class of theirs, their school, ' +
    'or a digest of what they have told you before; their own words are memory_search. ' +
    'The page you were given names them in [[double ' +
    'brackets]] -- pass what is inside the brackets. Reach for this when a question is about ' +
    'a subject they take, how their school works, or what they have already said, rather ' +
    'than answering from the summary alone.',
  inputSchema,
  async execute(input, ctx) {
    if (!ctx.vault) {
      return 'The vault is not available in this deployment.';
    }

    const document = await readDocument(ctx.vault, input.name);
    if (document) return renderNotes([document]);

    const available = (await listDocuments(ctx.vault)).map((doc) => doc.name);
    if (available.length === 0) return 'Nothing has been written about this student yet.';

    return (
      `There is no document called "${input.name}". ` +
      `The ones that exist are: ${available.join(', ')}.`
    );
  },
};
