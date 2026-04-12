import { createHash } from 'node:crypto';

/**
 * Regex matching hunk header line numbers: @@ -old,count +new,count @@
 * Captures the optional trailing function context after the closing @@.
 */
const HUNK_HEADER_LINE_NUMS_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/;

/**
 * Compute a stable content hash for a diff chunk that is resilient to
 * line-number shifts while remaining unique across files.
 *
 * The hash input is composed of:
 * 1. The file path — disambiguates identical hunks in different files
 * 2. The hunk header's function context (the text after the closing `@@`,
 *    e.g. " class Request:") — further disambiguates hunks with identical
 *    content lines in the same file but different scopes
 * 3. The diff content lines (`+`, `-`, ` ` prefixed) — the actual change
 *
 * Line numbers from the `@@ -old,count +new,count @@` header are stripped
 * so the hash remains stable when lines are added/removed above the chunk.
 *
 * @param filePath - The file path the chunk belongs to
 * @param diffText - The raw diff text of a chunk (including @@ header)
 * @returns Hex-encoded SHA-256 hash
 */
export function chunkContentHash(filePath: string, diffText: string): string {
  const lines = diffText.replace(/\r\n/g, '\n').trim().split('\n');
  const hashLines: string[] = [filePath];

  for (const line of lines) {
    const hunkMatch = line.match(HUNK_HEADER_LINE_NUMS_RE);
    if (hunkMatch) {
      // Keep only the function context portion (may be empty string)
      hashLines.push(`@@${hunkMatch[1]}`);
    } else {
      hashLines.push(line);
    }
  }

  const normalized = hashLines.join('\n');
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}
