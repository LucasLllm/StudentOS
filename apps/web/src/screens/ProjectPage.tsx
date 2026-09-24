import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, ProjectChat } from '@contexto/shared';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { modifiedLabel } from '../lib/when.js';
import { ConfirmDelete } from './ConfirmDelete.js';
import { BackIcon, FolderIcon } from './FolderIcon.js';
import { NewProject } from './NewProject.js';
import { ProjectContext } from './ProjectContext.js';
import { StartComposer } from './StartComposer.js';

interface Props {
  projectId: string;
}

type Tab = 'chats' | 'context';

/**
 * One project: its name, a box to start a chat in it, and what it holds.
 *
 * The composer is the new-chat one, unchanged, so starting a chat here is the
 * same act as starting one anywhere -- the chat simply belongs to the project
 * and begins knowing it. Below it, the two things a project is made of: the
 * chats in it, and its context.
 */
export function ProjectPage({ projectId }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  const [chats, setChats] = useState<ProjectChat[] | null>(null);
  const [tab, setTab] = useState<Tab>('chats');
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingNow, setDeletingNow] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await api.projects[':id'].$get({ param: { id: projectId } });
    if (!res.ok) {
      // 404 covers both "deleted" and "someone else's", deliberately.
      setMissing(true);
      return null;
    }
    const loaded = (await res.json()).project;
    setProject(loaded);
    return loaded;
  }, [projectId]);

  useEffect(() => {
    void load();
    void (async () => {
      const res = await api.projects[':id'].chats.$get({ param: { id: projectId } });
      if (res.ok) setChats((await res.json()).chats);
    })();
  }, [projectId, load]);

  // A menu closes when you click anywhere that is not it.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  async function remove() {
    setDeletingNow(true);
    try {
      const res = await api.projects[':id'].$delete({ param: { id: projectId } });
      if (res.ok) navigate({ name: 'projects' });
    } finally {
      setDeletingNow(false);
    }
  }

  if (missing) {
    return (
      <div className="panel">
        <p>This project does not exist, or it has been deleted.</p>
        <button onClick={() => navigate({ name: 'projects' })}>Back to projects</button>
      </div>
    );
  }

  if (!project) return <div className="project" aria-busy="true" />;

  return (
    <div className="project">
      <button className="quiet project-back" onClick={() => navigate({ name: 'projects' })}>
        <BackIcon />
        <span>Projects</span>
      </button>

      <header className="project-head">
        <div className="project-title">
          <span className="project-title-icon">
            <FolderIcon size={22} />
          </span>
          <h1>{project.name}</h1>
        </div>

        <div className="project-menu" ref={menu}>
          <button
            className="icon-button project-more"
            aria-label="Project options"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <DotsIcon />
          </button>
          {menuOpen && (
            <div className="chat-menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setEditing(true);
                }}
              >
                Edit name and goal
              </button>
              <button
                role="menuitem"
                className="danger-item"
                onClick={() => {
                  setMenuOpen(false);
                  setDeleting(true);
                }}
              >
                Delete project
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="project-composer">
        <StartComposer placeholder={`New chat in ${project.name}`} projectId={project.id} />
      </div>

      <div className="project-tabs" role="tablist" aria-label="Project">
        <button
          role="tab"
          aria-selected={tab === 'chats'}
          className={tab === 'chats' ? 'is-current' : ''}
          onClick={() => setTab('chats')}
        >
          Chats
        </button>
        <button
          role="tab"
          aria-selected={tab === 'context'}
          className={tab === 'context' ? 'is-current' : ''}
          onClick={() => setTab('context')}
        >
          Context
        </button>
      </div>

      {tab === 'chats' && <ChatList chats={chats} />}
      {tab === 'context' && <ProjectContext project={project} onGathered={() => void load()} />}

      {editing && (
        <NewProject
          editing={project}
          onCancel={() => setEditing(false)}
          onCreated={(saved) => {
            setProject(saved);
            setEditing(false);
          }}
        />
      )}

      {deleting && (
        <ConfirmDelete
          title={project.name}
          heading="Delete this project?"
          detail="and every chat in it will be permanently deleted, with the files added to it. Notes from your vault that it used stay in your vault."
          busy={deletingNow}
          onCancel={() => setDeleting(false)}
          onConfirm={() => void remove()}
        />
      )}
    </div>
  );
}

function ChatList({ chats }: { chats: ProjectChat[] | null }) {
  if (chats === null) return null;
  if (chats.length === 0) {
    return (
      <p className="muted project-none">
        No chats yet. Start one above and it will know this project&apos;s goal and context.
      </p>
    );
  }
  return (
    <ul className="project-chats">
      {chats.map((chat) => (
        <li key={chat.id}>
          <button onClick={() => navigate({ name: 'chat', agentId: chat.id })}>
            <span className="project-chat-text">
              <span className="project-chat-name">{chat.name}</span>
              {chat.preview && <span className="project-chat-preview">{chat.preview}</span>}
            </span>
            <span className="project-chat-when">{modifiedLabel(chat.updatedAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
    </svg>
  );
}
