/**
 * Format a datetime string as a relative time (e.g., "5m ago", "2h ago").
 * Falls back to a short date for older timestamps.
 */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(`${dateStr}Z`); // SQLite datetime is UTC without 'Z'
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return date.toLocaleDateString();
}
