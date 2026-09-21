import { useCallback, useEffect, useRef, useState } from 'react';
import { desktop } from '../lib/desktop.js';
import { useAgentSession } from '../lib/useAgentSession.js';

/**
 * The browser the agent is driving, sitting in the conversation.
 *
 * The live browser is a native view the app draws, and a native view always
 * paints on top of this page -- it cannot be blurred, scrolled under, or
 * covered by a dialog. Shown inline it therefore sat over the composer, the
 * scroll-down button and the delete-chat dialog, and never faded with the
 * transcript. So inline it is not shown at all.
 *
 * Instead the conversation holds an ordinary card: a real element that scrolls,
 * fades under the composer and sits beneath every dialog, exactly like the
 * text around it. The card cannot be typed or clicked into, which is the point
 * -- the page is the agent's to drive, not the student's to poke at over its
 * shoulder. Opening it is a deliberate act.
 *
 * The card makes that act obvious: it carries an Open control, and on hover it
 * lifts and grows the way anything that enlarges when pressed does. Opening it
 * raises the live native view as an overlay, where being on top is exactly
 * what a full-screen browser should be, and there is nothing behind it to
 * overlap.
 */
export function AgentSession({ agentId, working }: { agentId: string; working: boolean }) {
  const bridge = desktop();
  const { active, showing, portalId, frame: still } = useAgentSession(agentId);
  /*
   * Lit for the whole time the agent is working, not only while a page is
   * being driven. Between two steps it is still working, and a glow that
   * blinks out in the gaps looks like it stopped.
   */
  const lit = active || working;
  const [expanded, setExpanded] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const site = portalId || 'a page';

  const report = useCallback(() => {
    if (!bridge?.setSiteViewBounds) return;
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    void bridge.setSiteViewBounds({ x: box.x, y: box.y, width: box.width, height: box.height });
  }, [bridge]);

  /*
   * The native view is placed on the window only while the browser is open.
   *
   * Closed, the view is hidden and the card stands in for it. The agent drives
   * the hidden view just the same -- reading it, clicking and typing go through
   * the debugger, which does not need the page on screen -- so nothing is lost
   * by keeping it out of sight until the student asks to watch.
   */
  useEffect(() => {
    if (!showing) return;
    if (!expanded) {
      // Explicit, not merely "stop reporting": a previous open leaves the
      // view somewhere, and only telling the app to hide it takes it back off
      // the window.
      void bridge?.setSiteViewBounds?.(null);
      return;
    }
    report();
    // A native view does not move with the document, so anything that changes
    // the layout has to push new bounds or the browser is left behind.
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    const timer = setInterval(report, 400);
    return () => {
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      clearInterval(timer);
    };
  }, [showing, expanded, bridge, report]);

  // A panel that stops showing -- the work cleared, the conversation left --
  // must not keep an expansion that would reopen onto nothing.
  useEffect(() => {
    if (!showing) setExpanded(false);
  }, [showing]);

  // Leaving the conversation puts the view away, so it does not hang over
  // whatever the student goes to next.
  useEffect(() => {
    if (!showing) return;
    return () => void bridge?.setSiteViewBounds?.(null);
  }, [showing, bridge]);

  if (!bridge || !showing) return null;

  const label = (
    <span className="agent-browser-label">
      {portalId || 'Browser'}
      {lit && (
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  );

  return (
    <>
      <button
        type="button"
        className={`agent-browser-card${lit ? ' working' : ''}`}
        onClick={() => setExpanded(true)}
        aria-label={`Open the browser on ${site}`}
      >
        <span className="agent-browser-bar">
          <span className="agent-browser-chrome" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {label}
          <span className="agent-browser-open" aria-hidden="true">
            Open
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M6 2H2v4M10 14h4v-4M14 2l-5 5M2 14l5-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </span>
        {/*
          What the agent is looking at, as a still the app takes after every
          step. Before the first one arrives the card says what it is doing;
          after, it shows it.
        */}
        <span className={`agent-browser-preview${still ? ' has-still' : ''}`}>
          {still ? (
            <img className="agent-browser-still" src={still} alt="" />
          ) : (
            <>
              <span className="agent-browser-preview-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22">
                  <path
                    d="M9 3H3v6M15 21h6v-6M21 3l-7 7M3 21l7-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="agent-browser-preview-text">
                {lit ? `Working in ${site}…` : 'Click to open'}
              </span>
            </>
          )}
        </span>
      </button>

      {expanded && (
        <div className={`agent-browser-overlay${lit ? ' working' : ''}`}>
          {/*
            Above the page rather than over it. The native view covers every
            pixel of the frame, so this strip is the only place a control can
            be both seen and pressed.
          */}
          <div className="agent-browser-bar">
            <button
              className="agent-browser-close"
              onClick={() => setExpanded(false)}
              aria-label="Close"
            />
            {label}
          </div>
          <div className="agent-browser-frame" ref={frame} />
        </div>
      )}
    </>
  );
}
