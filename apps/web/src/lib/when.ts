/**
 * When something was last touched, the way a list of files says it.
 *
 * "Today" and "Yesterday" rather than times, because a list is for finding a
 * thing and a time of day is noise at that distance. The year only when it is
 * not this one: "Sep 7" is unambiguous until January.
 */
export function modifiedLabel(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((day(now).getTime() - day(then).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';

  return then.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(then.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
