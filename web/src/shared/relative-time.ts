/**
 * "just now", "2 min ago", "3 h ago" — the reading a player needs from a freshness stamp.
 *
 * The review (C7) called out a wall-clock time in monospace beside a 64-character id: precise to
 * the second, useless to a human, and twice as wide. A relative label is the fact that matters:
 * how stale is this number. The exact time stays available through the element's `title`.
 */
export function sinceLabel(at: number | null, now: number = Date.now()): string {
  if (at === null || !Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
