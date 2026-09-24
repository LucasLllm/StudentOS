import { useEffect, useRef, useState } from 'react';
import { AgentSession } from './AgentSession.js';
import { useAgentSession } from '../lib/useAgentSession.js';
import type { Agent, AgentActivity, Message } from '@contexto/shared';
import { api } from '../lib/api.js';
import { BackIcon } from './FolderIcon.js';
import { navigate } from '../lib/router.js';
import { sameConversation } from '../lib/conversation.js';
import { takeHandoff } from '../lib/handoff.js';
import type { PreviewTarget } from '../lib/preview.js';
import { FilePreview } from './FilePreview.js';
import { MessageText } from './MessageText.js';
import { MessageFiles } from './MessageFiles.js';
import { useAttachments } from '../lib/attachments.js';
import { pastedImages } from '../lib/paste.js';
import { chatsChanged } from '../lib/chats.js';
import type { Attachment as AttachmentItem } from '../lib/attachments.js';
import { AttachButton, AttachedFiles } from './AttachButton.js';
import { LogoMark } from './LogoMark.js';
import { SkillsRead } from './SkillsRead.js';
import { activityKey, pickPhrase } from '../lib/thinkingPhrases.js';

interface Props {
  agentId: string;
}

export function Chat({ agentId }: Props) {
  /*
   * Loaded here rather than handed down, because the id now comes from the
   * URL. That is what lets a student reopen a conversation from a link, or
   * refresh mid-chat without being thrown back to the list.
   */
  const [agent, setAgent] = useState<Agent | null>(null);
  const [missing, setMissing] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /*
   * A turn running that this page did not start -- asked before a refresh, or
   * from the other window. Without it the student sees a question of theirs
   * sitting unanswered and then an answer appearing from nowhere.
   */
  const [pending, setPending] = useState(false);
  /*
   * The step the turn is on, as last reported. Held rather than rendered
   * directly: what the student reads is a phrase chosen to suit it, and tool
   * names are not something to put in front of them.
   */
  const [activity, setActivity] = useState<AgentActivity | undefined>(undefined);
  /*
   * The skills the running turn has read so far.
   *
   * Its own list rather than a step: reading one is over before the next
   * poll, and the rows it puts on screen stay until the reply arrives to
   * carry them. Emptied the moment it does -- the reply shows the same names
   * above itself, and a list that lingered would show them twice.
   */
  const [skills, setSkills] = useState<readonly string[]>([]);
  const session = useAgentSession(agentId);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  /** Files on the composer, sent with the message rather than before it. */
  const attachments = useAttachments();
  /*
   * Object URLs for pictures sent in this session, by filename.
   *
   * The server has a copy the moment the upload lands, but asking it for one
   * costs a request the browser does not need to make -- it is holding the
   * file. Without this the thumbnail blinks: local preview, gone, then the
   * fetched copy a beat later.
   */
  const [localPreviews, setLocalPreviews] = useState<Record<string, string>>({});
  /*
   * Whether the newest message is on screen.
   *
   * Only used to decide whether to offer the jump button -- a student who has
   * scrolled up to reread something should not be dragged back down by an
   * arriving reply, but they should be told there is one and given one click
   * to reach it.
   */
  const [atBottom, setAtBottom] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  /*
   * The chat as last loaded, for code that runs before a render has caught up.
   * The first message is delivered in the same tick the chat is loaded, and a
   * file sent with it has to know already whether it goes into a project.
   */
  const agentRef = useRef<Agent | null>(null);

  useEffect(() => {
    setAgent(null);
    setMissing(false);
    setMessages([]);

    void (async () => {
      const detail = await api.agents[':id'].$get({ param: { id: agentId } });
      if (!detail.ok) {
        // 404 covers both "deleted" and "belongs to someone else" -- the API
        // deliberately does not distinguish them.
        setMissing(true);
        return;
      }
      const loaded = (await detail.json()).agent;
      agentRef.current = loaded;
      setAgent(loaded);

      const history = await api.agents[':id'].messages.$get({ param: { id: agentId } });
      if (history.ok) {
        const body = await history.json();
        setMessages(body.messages);
        setPending(body.pending);
        setActivity(body.activity);
      }

      /*
       * The message that started this chat, if it was started from the
       * new-chat screen.
       *
       * Sent here rather than there so the student watches the conversation
       * while the turn runs. It waits for the history above deliberately:
       * loading it calls setMessages with the server's list, which would wipe
       * the message this puts on screen optimistically.
       */
      const first = takeHandoff(agentId);
      if (first) void deliver(first.content, attachments.adopt(first.files));
    })();
  }, [agentId]);

  /*
   * Set by a send, so the next scroll happens wherever the student was.
   *
   * Their own message is the one thing worth pulling them down for. Sent from
   * partway up the conversation, it landed below the fold, and a send that
   * cannot be seen reads as one that did not happen. Spent by the scroll it
   * causes: the reply that follows is back under the rule below.
   */
  const justSent = useRef(false);

  useEffect(() => {
    // Only when they are already at the bottom, or have just sent something.
    // Scrolling someone back down mid-sentence because a reply landed is the
    // rudest thing a chat can do.
    if (atBottom || justSent.current) bottom.current?.scrollIntoView({ behavior: 'smooth' });
    justSent.current = false;
    /*
     * atBottom is read but not depended on, deliberately. This fires when the
     * conversation changes; re-running it every time the student scrolls would
     * have it fight them for the scroll position.
     */
  }, [messages, sending]);

  /*
   * The page scrolls, not a box inside it, so the window is what to watch.
   *
   * The slack is generous: a couple of lines from the bottom still counts as
   * "at the bottom", because a button that appears the instant a scroll
   * overshoots by three pixels is a button that flickers.
   */
  useEffect(() => {
    const check = () => {
      const from = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      setAtBottom(from < 120);
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, []);

  useEffect(() => {
    /*
     * Keep this conversation level with the other window onto it.
     *
     * The app and the website are the same page against the same account, and
     * a student moves between them mid-conversation. Loading the history once
     * on mount meant whichever one they were not typing into quietly went out
     * of date: a question asked in the app never appeared on the website, and
     * the answer to it never did either.
     *
     * It runs during a turn of our own as well, but only for what the turn is
     * doing -- the messages it brings back are ignored. The student's own
     * message is on screen optimistically and the reply is already on its way
     * here; a poll landing in the middle would replace both with the server's
     * older view of the same conversation.
     */
    let live = true;

    const pull = async () => {
      const res = await api.agents[':id'].messages.$get({ param: { id: agentId } });
      if (!live || !res.ok) return;
      const body = await res.json();
      /*
       * Kept as the same object while the step is unchanged. A fresh one every
       * poll would read as the agent having moved on, and the line would churn
       * through words while it sat on one tool for a minute.
       */
      setActivity((prev) =>
        activityKey(prev) === activityKey(body.activity) ? prev : body.activity,
      );
      setSkills((prev) => (prev.join('\n') === body.skills.join('\n') ? prev : body.skills));

      /*
       * Everything below is the server's view of a conversation this page is
       * not currently changing. During a turn of our own, `sending` already
       * says a turn is running and the reply is already on its way here --
       * taking the server's `pending` as well would leave it set behind our
       * back, and the line would sit under the finished answer for another
       * four seconds insisting the agent was still working.
       */
      if (sending) return;
      setPending(body.pending);
      // Replaced only when something was actually said, so the list is not
      // rebuilt under the student every few seconds.
      setMessages((prev) => (sameConversation(prev, body.messages) ? prev : body.messages));
    };

    const timer = setInterval(() => void pull(), 4000);
    // Coming back to the window is the moment it most obviously matters, and
    // waiting out the interval there is the difference people notice.
    const onFocus = () => void pull();
    window.addEventListener('focus', onFocus);

    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [agentId, sending]);

  /*
   * Whether this conversation has anything in flight. `sending` is a turn this
   * page started; `pending` is one it found already running.
   */
  const working = sending || pending;

  /*
   * What the line says, and when it changes.
   *
   * Once per step, not on a timer: the phrase is chosen to suit the work, so
   * changing it while the work has not changed would be saying something new
   * about nothing new. A minute spent on one tool holds one phrase, and the
   * mark beside it is what shows the turn is still alive.
   */
  const [phrase, setPhrase] = useState(() => pickPhrase(undefined));
  useEffect(() => {
    if (!working) return;
    setPhrase((current) => pickPhrase(activity, { avoid: [current] }));
  }, [working, activity]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const said = draft.trim();
    if ((!said && attachments.items.length === 0) || sending) return;

    /*
     * The composer empties on the keystroke, not when the network agrees.
     *
     * Taking a copy of the files first and clearing immediately is the whole
     * of it: leaving them in the box while a photograph is read left the
     * thumbnail sitting in the composer for several seconds after the student
     * pressed send, which reads as the press not having worked.
     */
    const going = attachments.items;
    setDraft('');
    attachments.clear();
    await deliver(said, going);
  }

  /**
   * Say something and wait for the reply.
   *
   * Split from the submit handler because the first message of a chat does not
   * come from the composer -- it is handed over by the screen the chat was
   * started on, and has to travel the same path once it arrives.
   */
  async function deliver(said: string, waiting: AttachmentItem[] = []) {
    setSending(true);
    setError(null);

    /*
     * On screen before anything is uploaded.
     *
     * Reading a photograph is a model call and takes seconds; doing that
     * before showing the student their own message left the composer frozen
     * with nothing happening, which is exactly what an app looks like when it
     * has crashed. The question goes up first, and the work happens under it.
     */

    /*
     * The files, as the message will show them, before any of them are sent.
     *
     * `name` is the filename here rather than the slug the server will
     * derive. It is only a React key until the server's copy of this message
     * replaces it, and the picture is found by filename either way.
     */
    const localFiles = waiting.map((item) => ({
      name: item.file.name,
      filename: item.file.name,
      image: Boolean(item.preview),
    }));
    if (waiting.length > 0) {
      setLocalPreviews((prev) => ({
        ...prev,
        ...Object.fromEntries(
          waiting.flatMap((item) =>
            item.preview ? [[item.file.name, item.preview] as const] : [],
          ),
        ),
      }));
    }

    // Optimistic: the turn is not streamed and can take several seconds, so
    // the student's own message has to appear immediately or the app feels
    // broken. Replaced by the server's copy when the response lands.
    const pending: Message = {
      id: `pending-${Date.now()}`,
      agentId,
      role: 'user',
      content: said,
      toolsUsed: [],
      skillsRead: [],
      attachments: localFiles,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, pending]);
    // In view too, however far up they had scrolled.
    justSent.current = true;

    try {
      /*
       * The files go up before the message that names them, so the note
       * exists by the time the turn reads it. A refusal stops the send: a
       * reply written around a missing attachment is worse than being told.
       */
      /*
       * The message is what they typed and nothing else.
       *
       * It used to have "Files I have attached: board.png" appended, which
       * showed up in their own bubble under the thumbnail already showing it.
       * The model learns what came with the message from the turn context,
       * where the files are carried by name with their contents.
       */
      const files =
        waiting.length > 0
          ? await attachments.upload(waiting, said, agentRef.current?.projectId ?? undefined)
          : [];
      const content = said;
      const res = await api.agents[':id'].messages.$post({
        param: { id: agentId },
        json: { content, ...(files.length > 0 ? { attachments: files } : {}) },
      });

      if (!res.ok) {
        const body = (await res.json()) as { message?: string };
        throw new Error(body.message ?? `Request failed (${res.status})`);
      }

      const data = await res.json();
      /*
       * The chat may have just been named. The rail is what shows names, and
       * it has no idea this happened.
       */
      if ('agentName' in data && data.agentName) chatsChanged();
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== pending.id),
        data.userMessage,
        data.assistantMessage,
      ]);
      // The reply carries what it read from here on.
      setSkills([]);
    } catch (cause) {
      setMessages((prev) => prev.filter((m) => m.id !== pending.id));
      setSkills([]);
      // Back into the box, so it can be sent again rather than retyped. The
      // attachments are still on the composer unless they uploaded cleanly.
      setDraft(said);
      setError(cause instanceof Error ? cause.message : 'Unknown error');
    } finally {
      setSending(false);
    }
  }

  if (missing) {
    return <p className="muted">That chat doesn&apos;t exist, or isn&apos;t yours.</p>;
  }

  if (!agent) return <p className="muted">Loading…</p>;

  return (
    <>
      {/*
        No header at all.

        The name is in the rail, highlighted, and repeating it over the
        conversation said the same thing twice while pushing the first message
        down the page. There is no way back here either, for the same reason:
        every chat and New are one click away on the left.
      */}
      <div className="workspace">
        <div className="chat-column">
          {/*
            The one header a chat has, and only inside a project: the rail
            does not list project chats, so this is the way back to the rest
            of the work it belongs to.
          */}
          {agent?.projectId && <ProjectCrumb projectId={agent.projectId} />}
          <div className="messages">
            {messages.length === 0 && <p className="muted">Say something to get started.</p>}

            {messages.map((message) => (
              <div key={message.id} className={`message ${message.role}`}>
                {/*
                 * Only assistant text is parsed for links. What a student types
                 * is shown exactly as they typed it.
                 */}
                {message.role === 'assistant' ? (
                  <>
                    <SkillsRead names={message.skillsRead} />
                    <MessageText text={message.content} onPreview={setPreview} />
                    {/*
                      The mark closes a reply the way a signature closes a
                      letter. With the bubbles gone there is no edge saying
                      where an answer stops, and two replies in a row would
                      otherwise read as one long one.
                    */}
                    <LogoMark size={26} working={false} />
                  </>
                ) : (
                  <>
                    <MessageFiles
                      attachments={message.attachments}
                      local={localPreviews}
                      projectId={agent?.projectId ?? undefined}
                    />
                    {message.content && <span className="message-said">{message.content}</span>}
                  </>
                )}
              </div>
            ))}

            {/*
              In the message flow, where the work was asked for. Renders
              nothing until this conversation's agent is actually driving a
              browser.
            */}
            <AgentSession agentId={agentId} working={sending} />

            {working && (
              /*
               * What it is doing, not just that it is doing something. A
               * minute of "Thinking" while a browser signs into a school
               * account reads as a hang; naming the site makes the same wait
               * legible, and naming the step does the same for the rest.
               *
               * The browser wins when there is one. A phrase is what the line
               * says when there is nothing specific to say, and "signing in to
               * veracross" is about as specific as this gets.
               */
              <>
                <SkillsRead names={skills} live />
                <div className="muted thinking">
                  <LogoMark size={20} working />
                  <span>
                    {session.active && session.portalId
                      ? `Signing in to ${session.portalId} and reading it…`
                      : phrase}
                  </span>
                </div>
              </>
            )}
            <div ref={bottom} />
          </div>

          {error && <p className="muted">{error}</p>}

          {/*
            The band that softens the seam.
            
            Its own element rather than a pseudo-element on the bar. As a
            ::before with a negative z-index it sat inside the bar's own
            stacking context, so what it blurred was the bar's opaque
            background rather than the transcript sliding under it.
          */}
          <div className="composer-fade" aria-hidden="true" />

          {!atBottom && messages.length > 0 && (
            <button
              className="to-bottom"
              type="button"
              aria-label="Jump to the latest message"
              onClick={() => bottom.current?.scrollIntoView({ behavior: 'smooth' })}
            >
              <DownIcon />
            </button>
          )}

          <form className="composer" onSubmit={send}>
            <AttachedFiles files={attachments.items} busy={sending} onRemove={attachments.remove} />

            <div className="composer-row">
              <AttachButton onChosen={attachments.add} disabled={sending} />

              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => {
                  // A picture on the clipboard is attached, not typed.
                  const images = pastedImages(e.clipboardData);
                  if (images.length === 0) return;
                  e.preventDefault();
                  attachments.add(images);
                }}
                /*
                 * Not the chat's name. It used to be an agent the student had
                 * named -- "Message Study buddy" -- and a title taken from the
                 * first thing they said reads as nonsense in its place:
                 * "Message What is due friday".
                 */
                placeholder="Message Contexto Agent"
                disabled={sending}
              />
              <button
                className="composer-send"
                type="submit"
                aria-label="Send"
                disabled={sending || (!draft.trim() && attachments.items.length === 0)}
              >
                <SendIcon />
              </button>
            </div>
          </form>

          {/*
            The floor under the bar.
            
            The bar is held off the bottom edge, and that gap was a window: the
            transcript kept scrolling through it, so a line of text sat below
            the composer in the corner of the eye. Opaque rather than faded,
            because there is nothing down there worth half-seeing -- the fade
            belongs above the bar, where text is on its way under.
          */}
          <div className="composer-floor" aria-hidden="true" />
        </div>

        {preview && <FilePreview target={preview} onClose={() => setPreview(null)} />}
      </div>
    </>
  );
}

/** "← CAS proposal", back to the project a chat belongs to. */
function ProjectCrumb({ projectId }: { projectId: string }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const res = await api.projects[':id'].$get({ param: { id: projectId } });
      if (res.ok) setName((await res.json()).project.name);
    })();
  }, [projectId]);

  return (
    <button
      className="quiet project-back chat-project"
      onClick={() => navigate({ name: 'project', projectId })}
    >
      <BackIcon />
      <span>{name ?? 'Project'}</span>
    </button>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true" focusable="false">
      <path
        d="M3.5 9h11M10 4.5 14.5 9 10 13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownIcon() {
  return (
    <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M9 3.5v11M4.5 10 9 14.5 13.5 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
