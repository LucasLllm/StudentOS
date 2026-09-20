// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NewChat } from './NewChat.js';

/**
 * A picture pasted into the new-chat box rides on the message like one
 * chosen from the + menu: it appears above the box, and can be removed.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<NewChat />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Paste onto the composer, and say whether the browser was left to do its own thing. */
function paste(...files: File[]): boolean {
  const box = container.querySelector<HTMLTextAreaElement>('.newchat-input');
  if (!box) throw new Error('no composer on screen');
  const clipboardData = new DataTransfer();
  for (const file of files) clipboardData.items.add(file);
  let allowed = true;
  act(() => {
    allowed = box.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
    );
  });
  return allowed;
}

const thumbnails = () => [...container.querySelectorAll('.attached-item.is-image img')];

describe('pasting a picture into a new chat', () => {
  it('puts it on the composer', () => {
    paste(new File(['x'], 'image.png', { type: 'image/png' }));
    expect(thumbnails()).toHaveLength(1);
  });

  it('takes the paste, so nothing else lands in the box', () => {
    const allowed = paste(new File(['x'], 'image.png', { type: 'image/png' }));
    expect(allowed).toBe(false);
  });

  it('leaves a paste of plain text to the browser', () => {
    const allowed = paste();
    expect(allowed).toBe(true);
    expect(thumbnails()).toHaveLength(0);
  });

  it('can be taken off again', () => {
    paste(new File(['x'], 'image.png', { type: 'image/png' }));
    expect(thumbnails()).toHaveLength(1);
    act(() => {
      container.querySelector<HTMLButtonElement>('.attached-remove')?.click();
    });
    expect(thumbnails()).toHaveLength(0);
  });
});
