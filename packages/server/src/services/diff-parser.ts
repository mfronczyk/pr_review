import { chunkContentHash } from './content-hash.js';

/**
 * A parsed chunk from a unified diff.
 * Each chunk corresponds to one hunk (@@...@@) in a file diff.
 */
export interface ParsedChunk {
  filePath: string;
  chunkIndex: number;
  diffText: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  oldStartLine: number;
  oldEndLine: number;
  fileStatus: 'added' | 'modified' | 'deleted' | 'renamed';
}

/**
 * A parsed file diff containing all its chunks.
 */
export interface ParsedFileDiff {
  filePath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath: string | null;
  chunks: ParsedChunk[];
}

// Matches the diff header for a file: "diff --git a/path b/path"
const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+?)$/;

// Matches hunk headers: "@@ -oldStart,oldCount +newStart,newCount @@ optional context"
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff string (from `git diff`) into structured file diffs and chunks.
 *
 * Each hunk (@@...@@) becomes a separate chunk. The chunk includes the hunk header
 * and all diff lines until the next hunk or file boundary.
 *
 * @param diffText - Raw unified diff output from git
 * @returns Array of parsed file diffs, each containing their chunks
 */
export function parseDiff(diffText: string): ParsedFileDiff[] {
  const lines = diffText.split('\n');
  const fileDiffs: ParsedFileDiff[] = [];

  let currentFile: ParsedFileDiff | null = null;
  let currentHunkLines: string[] = [];
  let currentHunkStart = 0;
  let currentHunkEnd = 0;
  let currentOldHunkStart = 0;
  let currentOldHunkEnd = 0;
  let chunkIndex = 0;

  function flushHunk(): void {
    if (currentFile && currentHunkLines.length > 0) {
      const text = currentHunkLines.join('\n');
      currentFile.chunks.push({
        filePath: currentFile.filePath,
        chunkIndex,
        diffText: text,
        contentHash: chunkContentHash(currentFile.filePath, text),
        startLine: currentHunkStart,
        endLine: currentHunkEnd,
        oldStartLine: currentOldHunkStart,
        oldEndLine: currentOldHunkEnd,
        fileStatus: currentFile.status,
      });
      chunkIndex++;
      currentHunkLines = [];
    }
  }

  function flushFile(): void {
    flushHunk();
    if (currentFile) {
      fileDiffs.push(currentFile);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file diff
    const diffMatch = line.match(DIFF_HEADER_RE);
    if (diffMatch) {
      flushFile();

      const oldPath = diffMatch[1];
      const newPath = diffMatch[2];

      currentFile = {
        filePath: newPath,
        status: 'modified',
        oldPath: oldPath !== newPath ? oldPath : null,
        chunks: [],
      };
      chunkIndex = 0;

      // Look ahead for file status indicators
      for (let j = i + 1; j < lines.length && j < i + 6; j++) {
        const lookLine = lines[j];
        if (lookLine.startsWith('new file mode')) {
          currentFile.status = 'added';
          break;
        }
        if (lookLine.startsWith('deleted file mode')) {
          currentFile.status = 'deleted';
          break;
        }
        if (lookLine.startsWith('similarity index') || lookLine.startsWith('rename from')) {
          currentFile.status = 'renamed';
          // Don't break — keep looking for rename from/to
        }
        if (lookLine.match(DIFF_HEADER_RE) || lookLine.match(HUNK_HEADER_RE)) {
          break;
        }
      }

      continue;
    }

    // Hunk header
    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      flushHunk();

      const newStart = Number.parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] ? Number.parseInt(hunkMatch[4], 10) : 1;
      const oldStart = Number.parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] ? Number.parseInt(hunkMatch[2], 10) : 1;

      currentHunkStart = newStart;
      currentHunkEnd = newStart + newCount - 1;
      currentOldHunkStart = oldStart;
      currentOldHunkEnd = oldStart + oldCount - 1;
      currentHunkLines = [line];
      continue;
    }

    // Diff content lines (inside a hunk)
    if (
      currentHunkLines.length > 0 &&
      (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '')
    ) {
      currentHunkLines.push(line);
    }

    // Skip other metadata lines (index, ---, +++, etc.)
  }

  // Flush the last file/hunk
  flushFile();

  return fileDiffs;
}

/**
 * Flatten all chunks from parsed file diffs into a single array.
 */
export function flattenChunks(fileDiffs: ParsedFileDiff[]): ParsedChunk[] {
  return fileDiffs.flatMap((fd) => fd.chunks);
}
