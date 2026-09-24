import { useMemo } from 'react';
import { pickGreeting } from '../lib/greeting.js';
import { LogoMark } from './LogoMark.js';
import { StartComposer } from './StartComposer.js';

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

  return (
    <div className="newchat">
      <h1 className="newchat-greeting">
        <LogoMark size={36} working={false} />
        <span>{greeting}</span>
      </h1>

      <StartComposer placeholder="How can I help you today?" />
    </div>
  );
}
