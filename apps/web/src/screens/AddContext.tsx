import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api.js';
import { pickDriveFiles, pickerConfigured } from '../lib/picker.js';
import { uploadToProject } from '../lib/upload.js';
import { CloseIcon } from './NewProject.js';

interface Props {
  projectId: string;
  onClose: () => void;
  /** Something landed; the grid should look again. */
  onAdded: () => void;
}

/**
 * Putting something into a project by hand.
 *
 * Three ways, because those are the three places a student's material is: on
 * their computer, in their Drive, and in their head. Everything else -- the
 * vault, their mail -- the agent brings in itself, which is why none of it has
 * a button here.
 */
export function AddContext({ projectId, onClose, onAdded }: Props) {
  const [mode, setMode] = useState<'choose' | 'text'>('choose');
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.body.classList.add('dialog-open');
    return () => document.body.classList.remove('dialog-open');
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  /*
   * One at a time, and every refusal kept. A folder of ten files where one
   * is a HEIC should add nine and say which one did not, not stop at the
   * first.
   */
  async function upload(files: File[]) {
    if (files.length === 0) return;
    const failed: string[] = [];
    for (const [index, file] of files.entries()) {
      setBusy(
        files.length === 1 ? `Reading ${file.name}…` : `Reading ${index + 1} of ${files.length}…`,
      );
      try {
        await uploadToProject(projectId, file);
        onAdded();
      } catch (cause) {
        failed.push(`${file.name}: ${cause instanceof Error ? cause.message : 'not added'}`);
      }
    }
    setBusy(null);
    setProblems(failed);
    if (failed.length === 0) onClose();
  }

  async function fromDrive() {
    setProblems([]);
    try {
      const picked = await pickDriveFiles();
      if (picked.length === 0) return;
      setBusy(picked.length === 1 ? 'Reading it from Drive…' : `Reading ${picked.length} files…`);
      const res = await api.projects[':id'].sources.drive.$post({
        param: { id: projectId },
        json: { fileIds: picked.slice(0, 10).map((doc) => doc.id) },
      });
      if (!res.ok) throw new Error(`Drive files could not be added (${res.status}).`);
      const { failed } = await res.json();
      onAdded();
      setBusy(null);
      if (failed.length === 0) onClose();
      else setProblems(failed.map((f) => f.reason));
    } catch (cause) {
      setBusy(null);
      setProblems([cause instanceof Error ? cause.message : 'Drive could not be opened.']);
    }
  }

  async function saveText(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !body.trim()) return;
    setBusy('Saving…');
    const res = await api.projects[':id'].sources.text.$post({
      param: { id: projectId },
      json: { title: title.trim(), body },
    });
    setBusy(null);
    if (!res.ok) {
      setProblems([`That could not be saved (${res.status}).`]);
      return;
    }
    onAdded();
    onClose();
  }

  return createPortal(
    <div className="scrim" onMouseDown={() => !busy && onClose()}>
      <div
        className="dialog add-context"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-context-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="project-dialog-head">
          <h2 id="add-context-title">{mode === 'text' ? 'Add a note' : 'Add context'}</h2>
          <button
            className="quiet icon-button"
            aria-label="Close"
            onClick={onClose}
            disabled={Boolean(busy)}
          >
            <CloseIcon />
          </button>
        </div>

        {mode === 'choose' && (
          <>
            <div
              className={`add-context-drop${dragging ? ' is-over' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void upload([...event.dataTransfer.files]);
              }}
            >
              <DropIcon />
              <span>{busy ?? 'Drop files here'}</span>
              <span className="muted">
                PDFs, documents, slides, spreadsheets, text and pictures
              </span>
            </div>

            <div className="add-context-ways">
              <button disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>
                <UploadIcon />
                <span>Upload</span>
              </button>
              {pickerConfigured() && (
                <button disabled={Boolean(busy)} onClick={() => void fromDrive()}>
                  <DriveIcon />
                  <span>Google Drive</span>
                </button>
              )}
              <button disabled={Boolean(busy)} onClick={() => setMode('text')}>
                <TextIcon />
                <span>Text</span>
              </button>
            </div>

            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void upload([...(event.target.files ?? [])]);
                event.target.value = '';
              }}
            />
          </>
        )}

        {mode === 'text' && (
          <form onSubmit={(event) => void saveText(event)}>
            <label>
              Title
              <input
                autoFocus
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. Feedback from Ms Chen"
              />
            </label>
            <label>
              Text
              <textarea
                className="add-context-text"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Paste or type anything this project should know."
              />
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setMode('choose')} disabled={Boolean(busy)}>
                Back
              </button>
              <button
                type="submit"
                className="primary"
                disabled={Boolean(busy) || !title.trim() || !body.trim()}
              >
                {busy ?? 'Add note'}
              </button>
            </div>
          </form>
        )}

        {problems.length > 0 && (
          <ul className="add-context-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}

function DropIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path
        d="M6 3.75h7.5L18 8.25v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-14.5a1 1 0 0 1 1-1ZM13.25 3.75v4.5H18M11.5 11.5v5.5M8.75 14.25h5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M8 10.5V2.75M5 5.5l3-3 3 3M2.75 10.5v1.75c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1V10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M3 3.75h10M3 7.25h10M3 10.75h6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Drive's own triangle, in its three colours: the one place a logo says more than a word. */
function DriveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M8.2 3h7.6l6.2 10.8h-7.6z" fill="#FFC107" />
      <path d="M2 13.8 5.8 20.4 12 9.6 8.2 3z" fill="#1E88E5" />
      <path d="M5.8 20.4h12.4l3.8-6.6H9.6z" fill="#4CAF50" />
    </svg>
  );
}
