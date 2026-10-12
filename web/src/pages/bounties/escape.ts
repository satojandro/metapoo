/**
 * Escape untrusted bounty brief / title text for safe HTML insertion.
 * Prefer `textContent` assignment when possible; this covers template builds.
 * Executable media (SVG/HTML/scripts) is never rendered as markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Truncate long briefs for cards while keeping escaped output. */
export function escapeAndClamp(value: string, maxChars: number): string {
  const clipped =
    value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
  return escapeHtml(clipped);
}

/**
 * Reject executable media URIs in fixture briefs.
 * Only allow https http and relative paths without script schemes.
 */
export function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value, "https://example.invalid");
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
