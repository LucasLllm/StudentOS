/**
 * A folder, for projects: in the rail, on the list, and above a project's name.
 *
 * Drawn in the same hand as the rail's other icons -- a 16-unit box, a 1.5
 * stroke, round ends -- so it sits beside New without looking borrowed.
 */
export function FolderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      <path
        d="M2.25 4.5c0-.69.56-1.25 1.25-1.25h2.6c.33 0 .65.13.88.37l.94.94c.23.24.55.37.88.37h3.7c.69 0 1.25.56 1.25 1.25v5.32c0 .69-.56 1.25-1.25 1.25h-9c-.69 0-1.25-.56-1.25-1.25V4.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Back to where a project page or a project chat came from. */
export function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M9.75 3.75 5.5 8l4.25 4.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
