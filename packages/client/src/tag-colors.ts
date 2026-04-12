/**
 * Auto-assign tag colors from a fixed palette based on tag name.
 * Uses a simple hash to deterministically map tag names to colors,
 * ensuring consistent colors across renders without storing colors in the DB.
 */

const TAG_PALETTE = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
  '#14b8a6', // teal
  '#a855f7', // purple
  '#64748b', // slate
  '#e11d48', // rose
] as const;

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Get a deterministic color for a tag name from the palette.
 */
export function getTagColor(name: string): string {
  const index = hashString(name) % TAG_PALETTE.length;
  return TAG_PALETTE[index];
}
