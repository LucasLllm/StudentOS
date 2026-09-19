import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent } from '@contexto/shared';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { useResolvedTheme } from '../lib/theme.js';
import type { Route } from '../lib/router.js';
import { signOut } from '../lib/auth.js';
import { initialOf } from '../lib/initial.js';
import { onChatsChanged } from '../lib/chats.js';
import { ConfirmDelete } from './ConfirmDelete.js';
import { LogoMark } from './LogoMark.js';

interface Props {
  route: Route;
  /** The signed-in student, for the footer. Either may be missing. */
  name?: string | null;
  email?: string | null;
  /** Opens the settings window over whatever is on screen. */
  onOpenSettings: () => void;
}

/**
 * The rail down the left: what you are, what you can start, what you have said.
 *
 * A chat is an agent row underneath -- the two words mean the same thing here
 * -- so the list is the same GET the agent list used to make. What has gone is
 * the idea that you build an agent before you can talk to one: New opens a
 * chat, and the agent behind it is plumbing the student never meets.
 */
export function Sidebar({ route, name, email, onOpenSettings }: Props) {
  const theme = useResolvedTheme();
  const [chats, setChats] = useState<Agent[] | null>(null);
  /** Which row's menu is open. Only ever one. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [deletingNow, setDeletingNow] = useState(false);

  /*
   * Re-read on every change of screen, not just on mount.
   *
   * A chat created from the new-chat screen exists only on the server until
   * something asks again, and the moment it is worth asking is exactly the
   * navigation that follows creating it. Keyed on the route rather than a
   * timer: one GET when the student moves, none while they read.
   */
  const at = route.name === 'chat' ? route.agentId : route.name;

  const reload = useCallback(async () => {
    try {
      const res = await api.agents.$get();
      if (!res.ok) return;
      setChats((await res.json()).agents);
    } catch {
      // A sidebar that cannot list is still a sidebar you can start from.
      // Failing here must not take the composer down with it.
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [at, reload]);

  // A chat is named from its first message, and that name arrives with the
  // reply -- in the conversation, which has no way to reach this list.
  useEffect(() => onChatsChanged(() => void reload()), [reload]);

  /**
   * Change one chat, on the server and on screen.
   *
   * The row is replaced with what the server returned rather than with what
   * was asked for, so the order the list is sorted by cannot drift from the
   * order the server would give on the next read.
   */
  async function update(
    id: string,
    changes: { name?: string; archived?: boolean; pinned?: boolean },
  ) {
    setMenuFor(null);
    const res = await api.agents[':id'].$patch({ param: { id }, json: changes });
    if (!res.ok) return;
    const { agent } = await res.json();
    setChats((prev) =>
      sortChats((prev ?? []).map((chat) => (chat.id === agent.id ? agent : chat))),
    );
  }

  async function remove(chat: Agent) {
    setDeletingNow(true);
    try {
      const res = await api.agents[':id'].$delete({ param: { id: chat.id } });
      if (!res.ok) return;
      setChats((prev) => (prev ?? []).filter((c) => c.id !== chat.id));
      setDeleting(null);
      // Standing in a chat that no longer exists is a 404 waiting to render.
      if (route.name === 'chat' && route.agentId === chat.id) go({ name: 'new' });
    } finally {
      setDeletingNow(false);
    }
  }

  // Archived chats are not gone, only out of the way. Settings lists them.
  const visible = (chats ?? []).filter((chat) => !chat.archivedAt);

  return (
    <aside className="sidebar">
      <button
        className="sidebar-brand"
        aria-label="Contexto Agent"
        onClick={() => go({ name: 'new' })}
      >
        <LogoMark size={30} working={false} />
        <img
          className="sidebar-wordmark"
          src={theme === 'dark' ? '/wordmark-dark.png' : '/wordmark.png'}
          alt="Contexto Agent"
        />
      </button>

      <button
        className={`sidebar-new${route.name === 'new' ? ' is-current' : ''}`}
        onClick={() => go({ name: 'new' })}
      >
        <PlusIcon />
        <span>New</span>
      </button>

      <nav className="sidebar-chats" aria-label="Chats">
        {visible.map((chat) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            current={route.name === 'chat' && route.agentId === chat.id}
            menuOpen={menuFor === chat.id}
            renaming={renaming === chat.id}
            onOpenMenu={() => setMenuFor((was) => (was === chat.id ? null : chat.id))}
            onCloseMenu={() => setMenuFor(null)}
            onStartRename={() => {
              setMenuFor(null);
              setRenaming(chat.id);
            }}
            onRename={(next) => {
              setRenaming(null);
              if (next && next !== chat.name) void update(chat.id, { name: next });
            }}
            onPin={() => void update(chat.id, { pinned: !chat.pinnedAt })}
            onArchive={() => void update(chat.id, { archived: true })}
            onDelete={() => {
              setMenuFor(null);
              setDeleting(chat);
            }}
            onOpen={() => go({ name: 'chat', agentId: chat.id })}
          />
        ))}
      </nav>

      <Account name={name} email={email} onOpenSettings={onOpenSettings} />

      {deleting && (
        <ConfirmDelete
          title={deleting.name}
          busy={deletingNow}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        />
      )}
    </aside>
  );
}

/**
 * The rail's order, reproduced on the client.
 *
 * The server sorts pinned first then most recently used, and pinning has to
 * move a chat now rather than at the next navigation. Kept identical to the
 * ORDER BY in routes/agents.ts -- if one changes the other has to.
 */
export function sortChats(chats: Agent[]): Agent[] {
  return [...chats].sort((a, b) => {
    if (!a.pinnedAt !== !b.pinnedAt) return a.pinnedAt ? -1 : 1;
    if (a.pinnedAt && b.pinnedAt) return b.pinnedAt.localeCompare(a.pinnedAt);
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

interface RowProps {
  chat: Agent;
  current: boolean;
  menuOpen: boolean;
  renaming: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onStartRename: () => void;
  onRename: (next: string) => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onOpen: () => void;
}

function ChatRow({ chat, current, menuOpen, renaming, ...on }: RowProps) {
  const box = useRef<HTMLDivElement>(null);
  const close = on.onCloseMenu;

  useEffect(() => {
    if (!menuOpen) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen, close]);

  if (renaming) {
    return (
      <form
        className="sidebar-chat is-renaming"
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.namedItem('title');
          on.onRename(input instanceof HTMLInputElement ? input.value.trim() : '');
        }}
      >
        <input
          name="title"
          defaultValue={chat.name}
          maxLength={80}
          autoFocus
          aria-label="Chat name"
          /*
           * Committed on blur as well as on Enter, because clicking away is
           * what a student does when they think they have finished typing.
           * Escape blanks it first, and an empty name is taken as "leave it".
           */
          onBlur={(event) => on.onRename(event.target.value.trim())}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.value = '';
              on.onRename('');
            }
          }}
        />
      </form>
    );
  }

  return (
    <div
      ref={box}
      className={`sidebar-chat${current ? ' is-current' : ''}${menuOpen ? ' is-menu-open' : ''}`}
    >
      <button className="sidebar-chat-open" title={chat.name} onClick={on.onOpen}>
        {chat.pinnedAt && <PinIcon />}
        <span>{chat.name}</span>
      </button>

      {/*
        Shown on hover and whenever its own menu is open. Without the second
        rule the button disappears the moment the pointer moves off the row and
        onto the menu it just opened, and the menu is left hanging off nothing.
      */}
      <button
        className="sidebar-chat-more"
        aria-label={`Options for ${chat.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={on.onOpenMenu}
      >
        <DotsIcon />
      </button>

      {menuOpen && (
        <div className="chat-menu" role="menu">
          <button role="menuitem" onClick={on.onStartRename}>
            Rename
          </button>
          <button role="menuitem" onClick={on.onPin}>
            {chat.pinnedAt ? 'Unpin' : 'Pin'}
          </button>
          <button role="menuitem" onClick={on.onArchive}>
            Archive
          </button>
          <button role="menuitem" className="danger-item" onClick={on.onDelete}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Navigation that also closes the drawer on a phone.
 *
 * The sidebar is a drawer under 900px, and a tap that changes the screen
 * behind an open drawer without closing it leaves the student looking at the
 * same list they just chose from.
 */
function go(route: Route): void {
  document.body.classList.remove('nav-open');
  navigate(route);
}

/**
 * The footer: who is signed in, and the way to the screens the header used to
 * hold.
 *
 * Settings and Sign out lost their home when the header went, and neither is
 * worth a row in the rail -- so they live behind the name, which is where a
 * student already looks for their own account.
 */
function Account({
  name,
  email,
  onOpenSettings,
}: {
  name?: string | null;
  email?: string | null;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  /** A menu that ignores a click elsewhere is a menu you cannot put away. */
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const label = name?.trim() || email?.split('@')[0] || 'Account';

  return (
    <div className="sidebar-account" ref={box}>
      {open && (
        <div className="account-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              // Not go(): settings is a window over this screen, not another one.
              document.body.classList.remove('nav-open');
              onOpenSettings();
            }}
          >
            Settings
          </button>
          <button role="menuitem" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}

      <button
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="account-initial" aria-hidden="true">
          {initialOf(label)}
        </span>
        <span className="account-name">{label}</span>
      </button>
    </div>
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

function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="3.2" r="1.35" fill="currentColor" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
      <circle cx="8" cy="12.8" r="1.35" fill="currentColor" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      className="pin-mark"
      viewBox="0 0 16 16"
      width="11"
      height="11"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 1.5h4l-.6 4.2 2.1 2.1H4.5l2.1-2.1z M8 7.8v6.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
