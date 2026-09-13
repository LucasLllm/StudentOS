import type { LlmProvider } from '@contexto/llm';

/**
 * Turning a picture into words, once, when it arrives.
 *
 * The alternative was carrying the image itself through every turn: widening
 * the message type, storing the bytes, and paying to re-read the same
 * worksheet on every question about it. Describing it once at the door is
 * cheaper in every direction and needs nothing downstream -- what lands in the
 * vault is a note like any other, found by the same search and read by the
 * same tools.
 *
 * It also means the description is what a later conversation gets, which is
 * the honest trade to understand: a question the description does not answer
 * cannot be answered by looking again. That is why the prompt asks for a
 * transcription rather than a summary. A photographed worksheet has to come
 * back as its questions, not as "a worksheet with questions on it".
 */

/** What a student most often photographs, and what the models accept. */
const READABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * HEIC is what an iPhone produces by default and no model reads it.
 *
 * Worth naming separately because the advice is specific and actionable --
 * the phone can be told to shoot JPEG, and a screenshot of the photo is a
 * JPEG -- where "unsupported image" would leave a student stuck holding the
 * only copy of their homework.
 */
export function isReadableImage(mimeType: string, filename: string): boolean {
  const type = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (READABLE.includes(type)) return true;
  if (type !== '') return false;
  return /\.(png|jpe?g|gif|webp)$/i.test(filename);
}

const PROMPT = [
  'Write out everything in this image so it can be read without seeing it.',
  '',
  'Transcribe all text exactly -- every question, heading, label, date, caption',
  'and handwritten note. Keep the order and the structure: numbered questions',
  'stay numbered, tables stay laid out, headings stay headings.',
  '',
  'Then, if the image contains anything that is not text -- a diagram, a graph,',
  'a photograph, a drawing -- describe it in enough detail to answer questions',
  'about it. For a graph give the axes, the units and the shape. For a diagram',
  'give the parts and how they connect.',
  '',
  'Write only the transcription and description. Do not comment on the image',
  'quality, do not introduce your answer, and do not say what you were asked.',
].join('\n');

export interface ImageToRead {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * The words in a picture.
 *
 * Returns null when the model had nothing to say, which is treated as "this
 * image holds nothing readable" rather than as a failure -- a photograph of a
 * wall is not an error.
 *
 * @throws when the model could not be reached at all. That is a circumstance,
 *   not a fact about the image, and the caller must not record it as one.
 */
export async function describeImage(
  llm: Pick<LlmProvider, 'chat'>,
  image: ImageToRead,
  userId: string,
  /**
   * What the student was saying when they attached it.
   *
   * Steers what gets transcribed rather than replacing the instruction:
   * "what's the answer to 3b" and "is this the right connector" want different
   * things read off the same photograph. Deliberately framed as background
   * rather than as a question to answer -- the note is a record of the picture
   * and has to stay useful to a conversation months later that never asked it.
   */
  context?: string,
): Promise<string | null> {
  const type = image.mimeType.split(';')[0]?.trim().toLowerCase() || guessType(image.filename);
  const dataUrl = `data:${type};base64,${toBase64(image.bytes)}`;

  const response = await llm.chat(
    {
      // Background work the student never waits on; medium is enough for a page
      // and a fifth of the reasoning bill.
      effort: 'medium',
      messages: [
        {
          role: 'system',
          content:
            'You transcribe images for a student who cannot see them. You are precise ' +
            'and you never invent text that is not there.',
        },
        {
          role: 'user',
          content: context?.trim()
            ? `${PROMPT}\n\nFor background, the student said this while attaching it -- use it to judge what matters in the image, not as a question to answer:\n${context.trim()}`
            : PROMPT,
          images: [dataUrl],
        },
      ],
    },
    { userId },
  );

  const text = response.content.trim();
  return text === '' ? null : text;
}

/** The extension, when the browser sent no type. */
function guessType(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if (match === 'jpg' || match === 'jpeg') return 'image/jpeg';
  return match ? `image/${match}` : 'image/png';
}

/**
 * Base64, in chunks.
 *
 * A ten-megabyte image is ten million arguments to String.fromCharCode if
 * spread in one call, which overflows the stack. Buffer would be shorter and
 * is deliberately not used: this module is imported by code that also runs in
 * a browser build.
 */
function toBase64(bytes: Uint8Array): string {
  const SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SIZE));
  }
  return btoa(binary);
}
