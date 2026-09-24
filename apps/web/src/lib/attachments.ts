import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadFile } from './upload.js';
import type { Uploaded } from './upload.js';

/**
 * Files waiting on the composer.
 *
 * They are held here, not sent anywhere, until the message goes. That is the
 * whole point of this module: a file picked and then thought better of should
 * leave nothing behind, and a file attached to a message that was never sent
 * was never attached to anything.
 *
 * It also puts the upload where the context is. The message being written is
 * what the file is for, and sending them together is what lets a picture be
 * read with the question already in view.
 */
export interface Attachment {
  /** Local, and only ever local: the server has never heard of this file yet. */
  id: string;
  file: File;
  /** An object URL, for the ones worth showing a picture of. */
  preview?: string;
}

let counter = 0;

export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  /*
   * Every object URL ever handed out, so unmounting can release them.
   *
   * A ref rather than state: revoking is cleanup, and a component that
   * re-rendered because of it would be re-rendering to say nothing.
   */
  const urls = useRef<string[]>([]);

  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current = [];
    },
    [],
  );

  /**
   * Wrap files into attachments this hook will clean up after.
   *
   * Separate from `add` because the new-chat screen hands its files to the
   * conversation and then unmounts, taking its own object URLs with it. The
   * conversation makes fresh ones from the same File objects, which survive
   * the navigation because nothing about them is tied to a component.
   */
  const adopt = useCallback((chosen: File[]): Attachment[] => {
    return chosen.map((file) => {
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      if (preview) urls.current.push(preview);
      counter += 1;
      return { id: `a${counter}`, file, ...(preview ? { preview } : {}) };
    });
  }, []);

  const add = useCallback(
    (chosen: File[]) => setItems((prev) => [...prev, ...adopt(chosen)]),
    [adopt],
  );

  const remove = useCallback((id: string) => {
    setItems((prev) => {
      const going = prev.find((item) => item.id === id);
      // Released now rather than at unmount: a student who attaches and
      // removes twenty photographs should not be holding twenty of them.
      if (going?.preview) URL.revokeObjectURL(going.preview);
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const clear = useCallback(() => setItems([]), []);

  /**
   * Send them, and hand back what they became.
   *
   * One at a time rather than all at once: reading a picture costs a model
   * call, and a student attaching six photographs should not open six of them
   * in parallel against their own quota.
   *
   * Throws on the first refusal, with the server's own sentence. The message
   * is not sent in that case, which is deliberate -- a reply that answers
   * around a missing attachment is worse than being told the attachment
   * failed.
   */
  const upload = useCallback(
    async (all: Attachment[], context: string, projectId?: string): Promise<Uploaded[]> => {
      const done: Uploaded[] = [];
      for (const item of all) done.push(await uploadFile(item.file, context, projectId));
      return done;
    },
    [],
  );

  return { items, add, adopt, remove, clear, upload };
}
