import { useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { chatTitle } from '../lib/chatTitle.js';
import { handOff } from '../lib/handoff.js';
import { pickGreeting } from '../lib/greeting.js';
import { navigate } from '../lib/router.js';
import { useAttachments } from '../lib/attachments.js';
import { pastedImages } from '../lib/paste.js';
import { AttachButton, AttachedFiles } from './AttachButton.js';
import { LogoMark } from './LogoMark.js';

interface Props {
  /** The signed-in student, if their account carries a name. */
  name?: string | null;
}

/**
 * The screen a new chat starts on: a greeting, and somewhere to type.
 *
 * The greeting is chosen once per mount rather than on every render. It reads
 * the clock at the moment the screen opens, which is the only moment it is
 * about -- recomputing it while the student types would swap the sentence
 * under them mid-thought, and at 4:59am it would do it for real.
 */
export function NewChat({ name }: Props) {
  const greeting = useMemo(() => pickGreeting(new Date(), name ?? undefined), [name]);
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
       * The files go first, and the message only if they all landed.
       *
       * A refusal has to stop the send: a reply written around a missing
       * attachment is worse than being told the attachment failed, because
       * the student cannot tell it happened.
       */
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
        json: { name: titleFor(said, filenames), purpose: '' },
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
    <div className="newchat">
      <h1 className="newchat-greeting">
        <LogoMark size={36} working={false} />
        <span>{greeting}</span>
      </h1>

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
            placeholder="How can I help you today?"
            rows={1}
            disabled={starting}
            aria-label="Message Contexto Agent"
          />

          <div className="newchat-tools">
            <AttachButton onChosen={attachments.add} disabled={starting} opens="down" />

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
    </div>
  );
}

/** What the chat is called: what they typed, or what they attached instead. */
function titleFor(said: string, names: string[]): string {
  return chatTitle(said || names.join(', '));
}
