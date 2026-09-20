/**
 * The pictures on a paste.
 *
 * A screenshot copied to the clipboard and pasted into the composer arrives as
 * a File, the same as one chosen from the + menu, and it is treated the same:
 * held on the composer, shown above the box, sent with the message. The one
 * thing the browser gets wrong is the name. Every pasted bitmap is called
 * `image.png`, and a message shows its pictures by filename -- two of those in
 * one message and the second would show the first. So those are told apart
 * here. A file copied from the desktop keeps the name it had.
 */
let pasted = 0;

export function pastedImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files)
    .filter((file) => file.type.startsWith('image/'))
    .map((file) => {
      if (!/^image\.[a-z0-9]+$/i.test(file.name)) return file;
      pasted += 1;
      const extension = file.name.slice(file.name.lastIndexOf('.'));
      return new File([file], `Pasted image ${pasted}${extension}`, { type: file.type });
    });
}
