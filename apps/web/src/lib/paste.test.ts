// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { pastedImages } from './paste.js';

/**
 * What a paste hands the composer.
 *
 * The browser does the hard part: a screenshot on the clipboard arrives as a
 * File already. What this decides is which of those files are pictures, and
 * what they are called -- because every browser calls a pasted bitmap
 * `image.png`, and a message shows its pictures by filename.
 */

const clipboard = (...files: File[]) => {
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  return data;
};

const png = (name = 'image.png') => new File(['x'], name, { type: 'image/png' });

describe('the images on a paste', () => {
  it('are the picture files and nothing else', () => {
    const data = clipboard(
      png('board.png'),
      new File(['x'], 'notes.pdf', { type: 'application/pdf' }),
    );
    expect(pastedImages(data).map((file) => file.name)).toEqual(['board.png']);
  });

  it('keep the name they came with', () => {
    const [file] = pastedImages(clipboard(png('board.png')));
    expect(file?.name).toBe('board.png');
    expect(file?.type).toBe('image/png');
  });

  /**
   * Two screenshots in one message must not share a name: the thumbnails
   * above the message are found by filename, so the second would show the
   * first. The browser's placeholder is replaced, and the extension kept.
   */
  it('get told apart when the browser called them all image.png', () => {
    const names = pastedImages(clipboard(png(), png())).map((file) => file.name);
    expect(names[0]).toMatch(/^Pasted image \d+\.png$/);
    expect(names[1]).toMatch(/^Pasted image \d+\.png$/);
    expect(names[0]).not.toBe(names[1]);
  });

  it('do not repeat a name across pastes', () => {
    const [first] = pastedImages(clipboard(png()));
    const [second] = pastedImages(clipboard(png()));
    expect(first?.name).not.toBe(second?.name);
  });

  it('are nothing when the paste carries no files', () => {
    expect(pastedImages(clipboard())).toEqual([]);
    expect(pastedImages(null)).toEqual([]);
  });
});
