import type { UploadRefusal } from '@contexto/agent';

/**
 * Why a file was turned away, in words a student can act on.
 *
 * Kept beside the route rather than in the vault module: what the extractor
 * reports is a fact about the file, and what to say about it is a fact about
 * this product. "no-text-layer" is the one that earns its own sentence -- a
 * scanned worksheet is not a broken file, and telling a student it failed
 * would send them looking for a fault that is not there.
 */
export const UPLOAD_REFUSALS: Record<UploadRefusal, string> = {
  'too-large': 'That file is too big. The limit is 10MB.',
  'unsupported-type':
    'There is no text in that file to read. Documents, slides, spreadsheets, PDFs, images and anything text-based work; a program or an archive does not.',
  empty: 'There was no text in that file.',
  'nothing-in-it': 'That opened, but there was nothing readable inside it.',
  'no-text-layer':
    'That PDF looks like a scan -- pictures of text rather than text. Send the pictures themselves and they can be read, or export the PDF again with a text layer.',
  unreadable: 'That PDF could not be opened. It may be password-protected or damaged.',
  'image-format':
    'That picture is in a format that cannot be read -- HEIC, which iPhones use by default, is the usual one. A screenshot of it works, or set the camera to "Most Compatible" to shoot JPEG.',
  'no-vision': 'Reading pictures is not switched on for this deployment.',
};
