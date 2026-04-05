import { createHash } from 'node:crypto';

/**
 * Compute a stable SHA-256 content hash of a diff text chunk.
 *
 * The hash is computed on the normalized diff text (trimmed, LF line endings)
 * so it survives line number shifts from force-pushes as long as the
 * actual change content is the same.
 *
 * @param diffText - The raw diff text of a chunk
 * @returns Hex-encoded SHA-256 hash
 */
export function contentHash(diffText: string): string {
  const normalized = diffText.replace(/\r\n/g, '\n').trim();
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}
