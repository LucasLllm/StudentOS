import { useState } from 'react';
import { api } from '../lib/api.js';
import { chatTitle } from '../lib/chatTitle.js';
import { handOff } from '../lib/handoff.js';
import { navigate } from '../lib/router.js';
import { useAttachments } from '../lib/attachments.js';
import { pastedImages } from '../lib/paste.js';
import { AttachButton, AttachedFiles } from './AttachButton.js';

interface Props {
  placeholder: string;
  /** Start the chat inside this project. */
  projectId?: string;
  /** Which way the attach menu opens: down under a greeting, up at the foot of a page. */
  opens?: 'down' | 'up';
}

/**
 * The box a chat is started from, on the new-chat screen and on a project's page.
 *
 * One component rather than two copies, because a chat started in a project
 * is a chat like any other: the same composer, the same attachments, the same
 * hand-off into the conversation. The only difference is the projectId the
 * chat is created with.
 */
export function StartComposer({ placeholder, projectId, opens = 'down' }: Props) {
  const [draft, setDraft] = useState('');
  const attachments = useAttachments();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  /**
   * Start the chat.
   *
   * The agent is created first and named after what was typed, then the
   * message is left for the conversation to send as it opens. Navigating
   * before the turn runs is the point: the reply can take several seconds, and
   * the student should be watching the conversation while it does, not a
   * screen that has not changed.
   */
  async function start(event: React.FormEvent) {
    event.preventDefault();
    const said = draft.trim();
    if ((!said && attachments.items.length === 0) || starting) return;

    setStarting(true);
    setError(null);

    try {
      /*
       * Nothing is uploaded here.
       *
       * Creating the chat is one fast request; reading a photograph is a
       * model call taking seconds. Doing the second one first left the
       * student watching an unchanged screen and a "Sending…" button. The
       * files are handed to the conversation, which shows them above the
       * message and does the reading underneath it.
       */
      const filenames = attachments.items.map((item) => item.file.name);
      const res = await api.agents.$post({
        json: { name: titleFor(said, filenames), purpose: '', ...(projectId ? { projectId } : {}) },
      });
      if (!res.ok) throw new Error(`Could not start a chat (${res.status})`);
      const { agent } = await res.json();

      handOff(
        agent.id,
        said,
        attachments.items.map((item) => item.file),
      );
      navigate({ name: 'chat', agentId: agent.id });
    } catch (cause) {
      // The draft and the attachments are both still there, so there is
      // nothing to restore -- only the button to give back.
      setError(cause instanceof Error ? cause.message : 'Unknown error');
      setStarting(false);
    }
  }

  return (
    <>
      {/*
        The glow is on the wrapper rather than the card, because it is painted
        by a blurred copy sitting behind it -- a shadow on the card itself
        cannot hold a three-colour gradient. It plays once, on entry.
      */}
      <div className="composer-glow">
        <form className="newchat-composer" onSubmit={(event) => void start(event)}>
          <AttachedFiles files={attachments.items} busy={starting} onRemove={attachments.remove} />

          <textarea
            className="newchat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              // A picture on the clipboard is attached, not typed.
              const images = pastedImages(event.clipboardData);
              if (images.length === 0) return;
              event.preventDefault();
              attachments.add(images);
            }}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line -- what every chat
              // box does, and a textarea does neither by default.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={placeholder}
            rows={1}
            disabled={starting}
            aria-label="Message Contexto Agent"
          />

          <div className="newchat-tools">
            <AttachButton onChosen={attachments.add} disabled={starting} opens={opens} />

            <button
              className="composer-send primary"
              type="submit"
              disabled={starting || (!draft.trim() && attachments.items.length === 0)}
            >
              {starting ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </div>

      {error && <p className="muted newchat-error">{error}</p>}
    </>
  );
}

/** What the chat is called: what they typed, or what they attached instead. */
function titleFor(said: string, names: string[]): string {
  return chatTitle(said || names.join(', '));
}
