import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  /** The chat's title, so the student can see which one they are about to lose. */
  title: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** What is being deleted, when it is not a chat. */
  heading?: string;
  detail?: string;
}

/**
 * The one question worth stopping for.
 *
 * Deleting a chat takes its transcript and its memories with it, and nothing
 * brings them back -- so this is a dialog rather than an undo, which is the
 * right way round only because there is no undo to offer.
 *
 * Rendered through a portal into the body rather than where it is written.
 * The rail becomes a drawer under 900px and gets a transform to slide it, and
 * a transformed ancestor makes itself the containing block for anything
 * `position: fixed` inside it -- so on a phone this dialog would be positioned
 * against the drawer and clipped to it rather than covering the screen.
 */
export function ConfirmDelete({ title, busy, onCancel, onConfirm, heading, detail }: Props) {
  const cancel = useRef<HTMLButtonElement>(null);

  /*
   * Blur what is behind by blurring it, not by asking the scrim to.
   *
   * backdrop-filter was the first attempt and it did not survive the build:
   * the minifier shipped only the -webkit- form, and even where it applies it
   * softens a backdrop rather than the page. A filter on the app itself is
   * unambiguous, works everywhere, and is what "everything around blurs"
   * actually describes.
   *
   * Safe only because the dialog is portalled OUT of the app: a filter makes
   * its element a containing block for fixed positioning, so a dialog inside
   * the blurred subtree would be positioned against it -- and blurred along
   * with everything else.
   *
   * Its own effect, with no dependencies. Sharing one with the key handler
   * below meant re-running on every render -- onCancel is written inline by
   * the caller and is a new function each time -- which took the class off and
   * put it back, restarting the transition into the blur on every keystroke
   * anywhere on the page.
   */
  useEffect(() => {
    document.body.classList.add('dialog-open');
    return () => document.body.classList.remove('dialog-open');
  }, []);

  useEffect(() => {
    // Focus lands on Cancel, not Delete: the safe option is the one a stray
    // Return should take.
    cancel.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return createPortal(
    <div className="scrim" onMouseDown={() => !busy && onCancel()}>
      {/* Stops a click inside the card reaching the scrim behind it. */}
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-delete-title">{heading ?? 'Are you sure you want to delete this chat?'}</h2>
        <p className="muted">
          <strong>{title}</strong> {detail ?? 'will be permanently deleted from your vault.'}
        </p>

        <div className="dialog-actions">
          <button ref={cancel} type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
