import { API_BASE_URL } from './env.js';

/**
 * Sending a file from the student's machine to their vault.
 *
 * Plain fetch rather than the typed client: this is multipart, and hono/client
 * is built around JSON bodies. The one thing that must not be forgotten is
 * `credentials: 'include'` -- the session is a cookie, and without it the
 * upload is an anonymous request that fails as unauthorised.
 *
 * Content-Type is deliberately unset. The browser writes it, and it has to,
 * because a multipart body is unparseable without the boundary marker only the
 * browser knows.
 */
export interface Uploaded {
  /** The vault note it became. */
  name: string;
  /** What it was called on their machine. */
  filename: string;
  /** Whether the original was kept, so the conversation can show it back. */
  image: boolean;
}

/**
 * @param projectId In a project chat the file goes into the project, which
 *   keeps it out of the student's vault and puts it in the project's context.
 */
export async function uploadFile(file: File, context = '', projectId?: string): Promise<Uploaded> {
  const body = new FormData();
  body.append('file', file);
  /*
   * The message this file is riding on.
   *
   * Only used to steer the reading of a picture: "what is the answer to 3b"
   * and "is this the right connector" want different things transcribed off
   * the same photograph. Ignored for everything else, where the text of a
   * document is the text of a document whatever was asked about it.
   */
  if (context.trim() !== '') body.append('context', context.trim());

  const path = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/sources/upload`
    : '/api/uploads';
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    body,
  });

  if (!res.ok) {
    /*
     * The server's own sentence, when it sent one.
     *
     * The refusals are written to be read by a student -- a scanned PDF needs
     * a different action from one that is too big -- and replacing them with
     * "Upload failed (400)" throws away the only part that helps.
     */
    const message = await res
      .json()
      .then((body: { message?: string }) => body.message)
      .catch(() => undefined);
    throw new Error(message ?? `Could not upload that file (${res.status}).`);
  }

  return (await res.json()) as Uploaded;
}

/** A file straight into a project's context, from its Add context window. */
export function uploadToProject(projectId: string, file: File): Promise<Uploaded> {
  return uploadFile(file, '', projectId);
}
