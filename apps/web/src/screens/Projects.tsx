import { useEffect, useState } from 'react';
import type { Project } from '@contexto/shared';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { modifiedLabel } from '../lib/when.js';
import { FolderIcon } from './FolderIcon.js';
import { NewProject } from './NewProject.js';

/**
 * Every project, most recently touched first.
 *
 * A list, not a grid of cards: what a student is doing here is finding one by
 * name, and names read down a column. Search filters what is already loaded,
 * because a student has tens of projects, not thousands.
 */
export function Projects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.projects.$get();
        if (!res.ok) throw new Error(String(res.status));
        setProjects((await res.json()).projects);
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  const wanted = query.trim().toLowerCase();
  const shown = (projects ?? []).filter((project) => project.name.toLowerCase().includes(wanted));

  return (
    <div className="projects">
      <header className="projects-head">
        <h1>Projects</h1>
        <div className="projects-tools">
          <label className="projects-search">
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
            />
          </label>
          <button className="primary" onClick={() => setCreating(true)}>
            New
          </button>
        </div>
      </header>

      {failed && <p className="muted">Your projects could not be loaded. Refresh to try again.</p>}

      {projects && projects.length === 0 && (
        <div className="projects-empty">
          <p>
            A project keeps the chats, files and notes for one piece of work together, so every chat
            in it starts knowing what the others worked out.
          </p>
          <button className="primary" onClick={() => setCreating(true)}>
            Create a project
          </button>
        </div>
      )}

      {projects && projects.length > 0 && (
        <table className="projects-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="projects-modified">
                Modified
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((project) => (
              <tr key={project.id}>
                <td>
                  <button
                    className="projects-row"
                    onClick={() => navigate({ name: 'project', projectId: project.id })}
                  >
                    <span className="projects-icon">
                      <FolderIcon />
                    </span>
                    <span className="projects-name">{project.name}</span>
                  </button>
                </td>
                <td className="projects-modified muted">{modifiedLabel(project.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {projects && projects.length > 0 && shown.length === 0 && (
        <p className="muted">No project is called anything like “{query.trim()}”.</p>
      )}

      {creating && (
        <NewProject
          onCancel={() => setCreating(false)}
          onCreated={(project) => navigate({ name: 'project', projectId: project.id })}
        />
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.2 10.2 13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
