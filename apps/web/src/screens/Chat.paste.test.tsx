// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat } from './Chat.js';

/**
 * A picture pasted into a conversation's composer is attached the same way
 * one chosen from the + menu is: shown above the box, sent with the message.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

beforeEach(async () => {
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});

  // An open, empty conversation: nothing said yet, nothing running.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = url.endsWith('/messages')
      ? { messages: [], pending: false, activity: undefined }
      : { agent: { id: 'a1', name: 'What is due friday', purpose: '' } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Chat agentId="a1" />);
  });
  await settle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function paste(...files: File[]) {
  const box = container.querySelector<HTMLInputElement>('.composer-row > input');
  if (!box) throw new Error('no composer on screen');
  const clipboardData = new DataTransfer();
  for (const file of files) clipboardData.items.add(file);
  act(() => {
    box.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
    );
  });
}

const thumbnails = () => [...container.querySelectorAll('.attached-item.is-image img')];

describe('pasting a picture into a conversation', () => {
  it('puts it on the composer', () => {
    paste(new File(['x'], 'image.png', { type: 'image/png' }));
    expect(thumbnails()).toHaveLength(1);
  });

  it('lets the message go with nothing typed', () => {
    paste(new File(['x'], 'image.png', { type: 'image/png' }));
    const send = container.querySelector<HTMLButtonElement>('.composer-send');
    expect(send?.disabled).toBe(false);
  });
});
