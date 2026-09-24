import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project, ProjectSource, SourceKind } from '@contexto/shared';
import { api } from '../lib/api.js';
import { API_BASE_URL } from '../lib/env.js';
import { modifiedLabel } from '../lib/when.js';
import { AddContext } from './AddContext.js';
import { CloseIcon } from './NewProject.js';

interface Props {
  project: Project;
  /** Told when the sweep that fills a new project has finished. */
  onGathered: () => void;
}

type Filter = 'all' | 'documents' | 'images' | 'email';
type Order = 'newest' | 'oldest';

const FILTERS: Record<Filter, (kind: SourceKind) => boolean> = {
  all: () => true,
  documents: (kind) => kind === 'document' || kind === 'pdf' || kind === 'text' || kind === 'drive',
  images: (kind) => kind === 'image',
  email: (kind) => kind === 'email',
};

const KIND_LABEL: Record<SourceKind, string> = {
  document: 'Document',
  pdf: 'PDF',
  image: 'Image',
  text: 'Note',
  drive: 'Drive',
  email: 'Email',
};

/** How often to look again while a new project's context is still arriving. */
const GATHER_POLL_MS = 3000;
/** When to stop looking whatever the server says. The server gives a sweep ten minutes. */
const GATHER_POLL_LIMIT_MS = 5 * 60_000;

/**
 * What a project knows: every item of its context, as a page you can see.
 *
 * Each card is a miniature of the thing itself -- a picture shows the
 * picture, anything with words shows its opening lines set small on a sheet
 * -- so a student recognises their own documents at a glance rather than
 * reading a list of filenames. Nothing marks how an item arrived. Something
 * the agent found and something the student uploaded are the same kind of
 * thing once they are here, and either can be taken out.
 */
export function ProjectContext({ project, onGathered }: Props) {
  const [sources, setSources] = useState<ProjectSource[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [order, setOrder] = useState<Order>('newest');
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<ProjectSource | null>(null);
  const [gathering, setGathering] = useState(project.gathering);

  const load = useCallback(async () => {
    const res = await api.projects[':id'].sources.$get({ param: { id: project.id } });
    if (res.ok) setSources((await res.json()).sources);
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * While the sweep runs, look again every few seconds, and stop the moment
   * it says it is done. Items arrive one at a time, so each look can show
   * more than the last.
   */
  useEffect(() => {
    if (!gathering) return;
    const started = Date.now();
    const stop = () => {
      window.clearInterval(timer);
      setGathering(false);
    };
    const timer = window.setInterval(() => {
      void (async () => {
        /*
         * Stopped by anything but a clear "still going": a project deleted in
         * another tab answers 404 for ever, and a page left open must not ask
         * every three seconds until it is closed.
         */
        if (Date.now() - started > GATHER_POLL_LIMIT_MS) return stop();
        await load();
        const res = await api.projects[':id'].$get({ param: { id: project.id } });
        if (!res.ok) return stop();
        if (!(await res.json()).project.gathering) {
          stop();
          onGathered();
        }
      })().catch(stop);
    }, GATHER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [gathering, load, project.id, onGathered]);

  async function remove(source: ProjectSource) {
    setSources((prev) => (prev ?? []).filter((s) => s.id !== source.id));
    const res = await api.projects[':id'].sources[':sourceId'].$delete({
      param: { id: project.id, sourceId: source.id },
    });
    if (!res.ok) void load();
  }

  const shown = (sources ?? [])
    .filter((source) => FILTERS[filter](source.kind))
    .sort((a, b) =>
      order === 'newest' ? b.addedAt.localeCompare(a.addedAt) : a.addedAt.localeCompare(b.addedAt),
    );

  return (
    <section className="context" aria-label="Context">
      <div className="context-bar">
        <button className="context-add" onClick={() => setAdding(true)}>
          <PlusIcon />
          <span>Add context</span>
        </button>
        <div className="context-controls">
          <select
            aria-label="Order"
            value={order}
            onChange={(event) => setOrder(event.target.value as Order)}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>
          <select
            aria-label="Show"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
          >
            <option value="all">All</option>
            <option value="documents">Documents</option>
            <option value="images">Images</option>
            <option value="email">Email</option>
          </select>
        </div>
      </div>

      {gathering && (
        <p className="context-gathering" role="status">
          <span className="context-gathering-dot" aria-hidden="true" />
          Looking through your files, notes and email for what belongs here…
        </p>
      )}

      {sources && sources.length === 0 && !gathering && (
        <p className="muted project-none">
          Nothing here yet. Add files, paste notes or pick from Drive, and your agent adds what it
          uses from your vault, Drive and email as you work.
        </p>
      )}

      {shown.length > 0 && (
        <ul className="context-grid">
          {shown.map((source) => (
            <li key={source.id} className="context-card">
              <button
                className="context-open"
                onClick={() => setViewing(source)}
                aria-label={`Open ${source.name}`}
              >
                <span className={`context-page${source.image ? ' is-image' : ''}`}>
                  {source.image ? (
                    <img
                      src={`${API_BASE_URL}/api/projects/${encodeURIComponent(project.id)}/images/${encodeURIComponent(source.name)}`}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="context-page-text">{source.preview || source.summary}</span>
                  )}
                </span>
                <span className="context-name" title={source.summary}>
                  {displayName(source.name)}
                </span>
                <span className="context-meta">
                  {KIND_LABEL[source.kind]}, {modifiedLabel(source.addedAt)}
                </span>
              </button>
              <button
                className="context-remove"
                aria-label={`Remove ${source.name} from this project`}
                title="Remove from project"
                onClick={() => void remove(source)}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}

      {sources && sources.length > 0 && shown.length === 0 && (
        <p className="muted project-none">Nothing of that kind in this project.</p>
      )}

      {adding && (
        <AddContext
          projectId={project.id}
          onClose={() => setAdding(false)}
          onAdded={() => void load()}
        />
      )}

      {viewing && (
        <SourceViewer projectId={project.id} source={viewing} onClose={() => setViewing(null)} />
      )}
    </section>
  );
}

/** "cas-idea-summary" reads as "cas idea summary": the slug is the vault's, not a title. */
function displayName(name: string): string {
  const words = name.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function SourceViewer({
  projectId,
  source,
  onClose,
}: {
  projectId: string;
  source: ProjectSource;
  onClose: () => void;
}) {
  const [body, setBody] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await api.projects[':id'].sources[':sourceId'].$get({
        param: { id: projectId, sourceId: source.id },
      });
      setBody(res.ok ? (await res.json()).body : 'This could not be opened.');
    })();
  }, [projectId, source.id]);

  useEffect(() => {
    document.body.classList.add('dialog-open');
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('dialog-open');
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="scrim" onMouseDown={onClose}>
      <div
        className="dialog context-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-viewer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="project-dialog-head">
          <h2 id="context-viewer-title">{displayName(source.name)}</h2>
          <button className="quiet icon-button" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {source.summary && <p className="muted context-viewer-summary">{source.summary}</p>}
        {source.image && (
          <img
            className="context-viewer-image"
            src={`${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(source.name)}`}
            alt={source.name}
          />
        )}
        <div className="context-viewer-body">{body ?? 'Opening…'}</div>
      </div>
    </div>,
    document.body,
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M8 3.25v9.5M3.25 8h9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
