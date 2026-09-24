import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '@contexto/shared';
import { api } from '../lib/api.js';

interface Props {
  onCancel: () => void;
  onCreated: (project: Project) => void;
  /** Editing an existing project's name and goal, rather than making one. */
  editing?: Project;
}

/**
 * Starting a project: what it is called, and what it is for.
 *
 * The goal is not decoration. It is what the agent is told on every chat in
 * the project, and what the first sweep searches the student's files with, so
 * the placeholder asks for the things that make both work: what done looks
 * like, and anything the agent should know.
 */
export function NewProject({ onCancel, onCreated, editing }: Props) {
  const [name, setName] = useState(editing?.name ?? '');
  const [goal, setGoal] = useState(editing?.instructions ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.body.classList.add('dialog-open');
    first.current?.focus();
    return () => document.body.classList.remove('dialog-open');
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = editing
        ? await api.projects[':id'].$patch({
            param: { id: editing.id },
            json: { name: name.trim(), instructions: goal },
          })
        : await api.projects.$post({ json: { name: name.trim(), instructions: goal } });
      if (!res.ok) throw new Error(`Could not save the project (${res.status}).`);
      onCreated((await res.json()).project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the project.');
      setBusy(false);
    }
  }

  return createPortal(
    <div className="scrim" onMouseDown={() => !busy && onCancel()}>
      <form
        className="dialog project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <div className="project-dialog-head">
          <h2 id="project-dialog-title">{editing ? 'Edit project' : 'New project'}</h2>
          <button type="button" className="quiet icon-button" aria-label="Close" onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        <label>
          Project name
          <input
            ref={first}
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. History IA on the Cuban missile crisis"
          />
        </label>

        <label>
          What&apos;s the goal?
          <textarea
            value={goal}
            maxLength={4000}
            rows={4}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="What you're working on, what done looks like, and anything the agent should know."
          />
        </label>

        {!editing && (
          <p className="muted project-dialog-note">
            Your agent will look through your files, notes and email for anything that belongs here.
          </p>
        )}

        {error && <p className="project-dialog-error">{error}</p>}

        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Create project'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M4 4l8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
