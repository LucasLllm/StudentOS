/** ~10k tokens, the cap Codex uses; equal to the web fetch cap so a page passes whole. */
export const TOOL_RESULT_MAX_CHARS = 40_000;

/**
 * Keeps head and tail because the command and the outcome are where the
 * signal is; tail-only loses what was asked.
 */
export function truncateToolResult(
  text: string,
  maxChars = TOOL_RESULT_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const halfLen = Math.floor(maxChars / 2);
  const head = text.slice(0, halfLen);
  const tail = text.slice(text.length - halfLen);
  const dropped = text.length - head.length - tail.length;
  const marker = `\n…[${dropped} characters truncated; call the tool again with a narrower request if you need the middle]…\n`;
  return { text: `${head}${marker}${tail}`, truncated: true };
}
