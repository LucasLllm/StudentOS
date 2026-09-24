import { API_BASE_URL } from '../lib/env.js';
import type { MessageAttachment } from '@contexto/shared';

/**
 * The files that went with a message, above it.
 *
 * Above rather than below, and outside the bubble rather than in it, because
 * that is the order they were made in: the picture was attached, then the
 * question was asked about it.
 *
 * A `local` preview is used when there is one. That is the object URL of the
 * file still in the browser, and it is what makes a sent message appear
 * complete the instant it is sent rather than a moment later when the server
 * has a copy to serve.
 *
 * Keyed by filename rather than by note name, deliberately. The note name is
 * a slug the server derives, and keying on it would mean reimplementing that
 * derivation in the browser and keeping the two in step for ever. The
 * filename is what both ends already agree on.
 */
export function MessageFiles({
  attachments,
  local,
  projectId,
}: {
  /*
   * Optional, and read defensively. A message stored before this column
   * existed has no attachments at all, and a transcript that throws on one of
   * those takes the whole conversation down rather than one line of it.
   */
  attachments?: MessageAttachment[];
  local?: Record<string, string>;
  /** A project chat's pictures were kept in the project, and are served from there. */
  projectId?: string;
}) {
  if (!attachments?.length) return null;

  return (
    <div className="message-files">
      {attachments.map((file) =>
        file.image ? (
          <img
            key={file.name}
            className="message-image"
            src={
              local?.[file.filename] ??
              (projectId
                ? `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(file.name)}`
                : `${API_BASE_URL}/api/uploads/${encodeURIComponent(file.name)}`)
            }
            alt={file.filename}
            loading="lazy"
          />
        ) : (
          <span key={file.name} className="message-doc">
            {file.filename}
          </span>
        ),
      )}
    </div>
  );
}
