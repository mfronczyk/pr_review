/**
 * DiffViewer – renders diff chunks grouped by file in bordered boxes (like GitHub PRs).
 * Each file is a rounded container with a sticky header and all its chunks inside.
 * Uses @tanstack/react-virtual for efficient rendering of large PRs.
 *
 * Comments are anchored to specific new-file lines within chunks and rendered
 * inline as threads (root + flat replies).
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { InlineThread, NewCommentForm } from '@/components/InlineComment';
import type { ChunkWithDetails, Comment, CommentThread } from '@pr-review/shared';

// ── Types ───────────────────────────────────────────────────

interface DiffViewerProps {
  chunks: ChunkWithDetails[];
  onToggleReviewed: (chunkId: number) => void;
  onAddComment: (chunkId: number, body: string, line: number) => Promise<void>;
  onReplyComment: (chunkId: number, parentId: number, body: string) => Promise<void>;
  onUpdateComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onPublishComment: (commentId: number) => Promise<void>;
  onResolveThread: (commentId: number) => Promise<void>;
  onUnresolveThread: (commentId: number) => Promise<void>;
}

/** Each virtual row is one file group (header + all chunks). */
interface FileGroup {
  filePath: string;
  chunks: ChunkWithDetails[];
  allReviewed: boolean;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Group a flat Comment[] into threads keyed by new-file line number.
 * Returns a Map from line number to CommentThread[].
 */
function groupCommentsIntoThreads(comments: Comment[]): Map<number, CommentThread[]> {
  const roots = comments.filter((c) => c.parentId == null);
  const repliesByParent = new Map<number, Comment[]>();
  for (const c of comments) {
    if (c.parentId != null) {
      const list = repliesByParent.get(c.parentId);
      if (list) {
        list.push(c);
      } else {
        repliesByParent.set(c.parentId, [c]);
      }
    }
  }

  const byLine = new Map<number, CommentThread[]>();
  for (const root of roots) {
    const replies = repliesByParent.get(root.id) ?? [];
    const thread: CommentThread = { root, replies };
    const existing = byLine.get(root.line);
    if (existing) {
      existing.push(thread);
    } else {
      byLine.set(root.line, [thread]);
    }
  }
  return byLine;
}

// ── Tag Pill ────────────────────────────────────────────────

function TagPill({ name, color }: { name: string; color: string }): React.ReactElement {
  return (
    <span
      className="inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        backgroundColor: `${color}22`,
        color: color || '#9ca3af',
        border: `1px solid ${color}44`,
      }}
    >
      {name}
    </span>
  );
}

// ── Priority Badge ──────────────────────────────────────────

function PriorityBadge({
  priority,
}: {
  priority: string;
}): React.ReactElement | null {
  const styles: Record<string, string> = {
    high: 'bg-red-100 text-red-700 border-red-300 dark:bg-red-900/50 dark:text-red-300 dark:border-red-700',
    medium:
      'bg-yellow-100 text-yellow-700 border-yellow-300 dark:bg-yellow-900/50 dark:text-yellow-300 dark:border-yellow-700',
    low: 'bg-surface-secondary text-fg-tertiary border-border-primary',
  };
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${styles[priority] ?? styles.low}`}
    >
      {priority}
    </span>
  );
}

// ── Chunk Header ────────────────────────────────────────────

function ChunkHeader({
  chunk,
  onToggle,
  isLast,
}: {
  chunk: ChunkWithDetails;
  onToggle: () => void;
  isLast: boolean;
}): React.ReactElement {
  const commentCount = chunk.comments.length;
  return (
    <div
      className={`flex items-center gap-2 border-t border-border-secondary bg-surface-secondary px-3 py-1.5 ${
        chunk.reviewed && isLast ? '' : ''
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border text-xs ${
          chunk.reviewed
            ? 'border-green-600 bg-green-600 text-white'
            : 'border-fg-faint bg-transparent text-transparent hover:border-fg-tertiary'
        }`}
        title={chunk.reviewed ? 'Mark unreviewed' : 'Mark reviewed'}
      >
        {chunk.reviewed ? '✓' : ''}
      </button>

      <span className="text-xs text-fg-muted">
        L{chunk.startLine}–{chunk.endLine}
      </span>

      {chunk.tags.map((t) => (
        <TagPill key={t.id} name={t.name} color={t.color} />
      ))}

      {chunk.metadata?.priority && <PriorityBadge priority={chunk.metadata.priority} />}

      {commentCount > 0 && (
        <span className="text-xs text-fg-muted">
          {commentCount} comment{commentCount !== 1 ? 's' : ''}
        </span>
      )}

      {chunk.reviewed && <span className="ml-auto text-[10px] text-success-fg">Reviewed</span>}
    </div>
  );
}

// ── Review Note ─────────────────────────────────────────────

function ReviewNote({ note }: { note: string }): React.ReactElement {
  return (
    <div className="border-t border-border-secondary bg-diff-note-bg px-3 py-1 text-xs text-diff-note-fg">
      <span className="mr-1">⚡</span>
      {note}
    </div>
  );
}

// ── Line Number Parsing ─────────────────────────────────────

interface ParsedDiffLine {
  type: 'context' | 'add' | 'del' | 'hunk-header' | 'empty';
  text: string;
  oldLineNum: number | null;
  newLineNum: number | null;
}

/**
 * Parse a chunk's diff text into structured lines with line numbers.
 * Tracks old/new line counters based on @@ hunk headers.
 */
function parseDiffLines(diffText: string): ParsedDiffLine[] {
  const rawLines = diffText.split('\n');
  const result: ParsedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of rawLines) {
    if (line.startsWith('@@')) {
      // Parse hunk header: @@ -oldStart[,oldCount] +newStart[,newCount] @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = Number.parseInt(match[1], 10);
        newLine = Number.parseInt(match[2], 10);
      }
      result.push({ type: 'hunk-header', text: line, oldLineNum: null, newLineNum: null });
    } else if (line.startsWith('+')) {
      result.push({ type: 'add', text: line, oldLineNum: null, newLineNum: newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      result.push({ type: 'del', text: line, oldLineNum: oldLine, newLineNum: null });
      oldLine++;
    } else if (line === '') {
      // Trailing empty line at end of chunk
      result.push({ type: 'empty', text: '', oldLineNum: null, newLineNum: null });
    } else {
      // Context line (starts with space or is plain text)
      result.push({ type: 'context', text: line, oldLineNum: oldLine, newLineNum: newLine });
      oldLine++;
      newLine++;
    }
  }

  return result;
}

// ── Diff Line ───────────────────────────────────────────────

const lineStyles: Record<ParsedDiffLine['type'], { bg: string; text: string }> = {
  add: { bg: 'bg-diff-add-bg', text: 'text-diff-add-fg' },
  del: { bg: 'bg-diff-del-bg', text: 'text-diff-del-fg' },
  'hunk-header': { bg: 'bg-diff-info-bg/30', text: 'text-diff-info-fg' },
  context: { bg: '', text: 'text-fg-secondary' },
  empty: { bg: '', text: 'text-fg-secondary' },
};

const gutterStyles: Record<ParsedDiffLine['type'], string> = {
  add: 'bg-diff-add-gutter text-diff-add-fg/60',
  del: 'bg-diff-del-gutter text-diff-del-fg/60',
  'hunk-header': 'bg-diff-info-bg/30 text-diff-info-fg/50',
  context: 'text-fg-muted',
  empty: 'text-fg-muted',
};

function DiffLine({
  parsed,
  onClickAdd,
}: {
  parsed: ParsedDiffLine;
  onClickAdd?: () => void;
}): React.ReactElement {
  const { bg, text } = lineStyles[parsed.type];
  const gutter = gutterStyles[parsed.type];
  const canComment = parsed.type !== 'hunk-header' && parsed.type !== 'empty';

  return (
    <div className={`group/line relative flex ${bg}`}>
      {/* Add comment button — appears on hover in the gutter area */}
      {canComment && onClickAdd && (
        <button
          type="button"
          onClick={onClickAdd}
          className="absolute left-0 top-0 z-10 flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-xs font-bold text-white opacity-0 hover:bg-blue-500 group-hover/line:opacity-100"
          title="Add comment"
        >
          +
        </button>
      )}
      {/* Old line number gutter */}
      <span
        className={`inline-block w-[50px] flex-shrink-0 select-none border-r border-border-secondary px-2 text-right font-mono text-xs leading-5 ${gutter}`}
      >
        {parsed.oldLineNum ?? ''}
      </span>
      {/* New line number gutter */}
      <span
        className={`inline-block w-[50px] flex-shrink-0 select-none border-r border-border-secondary px-2 text-right font-mono text-xs leading-5 ${gutter}`}
      >
        {parsed.newLineNum ?? ''}
      </span>
      {/* Code content */}
      <code className={`flex-1 px-3 text-xs leading-5 ${text}`}>{parsed.text || ' '}</code>
    </div>
  );
}

// ── Chunk Block ─────────────────────────────────────────────

const COLLAPSE_DURATION_MS = 300;

function ChunkBlock({
  chunk,
  onToggleReviewed,
  onAddComment,
  onReplyComment,
  onUpdateComment,
  onDeleteComment,
  onPublishComment,
  onResolveThread,
  onUnresolveThread,
  isLast,
}: {
  chunk: ChunkWithDetails;
  onToggleReviewed: () => void;
  onAddComment: (body: string, line: number) => Promise<void>;
  onReplyComment: (parentId: number, body: string) => Promise<void>;
  onUpdateComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onPublishComment: (commentId: number) => Promise<void>;
  onResolveThread: (commentId: number) => Promise<void>;
  onUnresolveThread: (commentId: number) => Promise<void>;
  isLast: boolean;
}): React.ReactElement {
  const parsedLines = useMemo(() => parseDiffLines(chunk.diffText), [chunk.diffText]);
  const contentRef = useRef<HTMLDivElement>(null);
  // Track which line the comment form is open for (null = closed)
  const [commentFormLine, setCommentFormLine] = useState<number | null>(null);

  // Group comments into threads by line
  const threadsByLine = useMemo(() => groupCommentsIntoThreads(chunk.comments), [chunk.comments]);

  // Animation: always render content, animate height via ref manipulation
  const [collapsed, setCollapsed] = useState(chunk.reviewed);
  const isFirstRender = useRef(true);

  useEffect(() => {
    // Skip animation on initial mount
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    if (!chunk.reviewed) {
      // Expanding: set collapsed=false so the content div renders,
      // then the second useEffect handles the expand animation.
      setCollapsed(false);
      return;
    }

    // Collapsing: animate height to 0, then set collapsed=true
    const el = contentRef.current;
    if (!el) return;

    const height = el.scrollHeight;
    el.style.height = `${height}px`;
    el.style.transition = 'none';
    // Force reflow
    void el.offsetHeight;
    el.style.transition = `height ${COLLAPSE_DURATION_MS}ms ease-in-out, opacity ${COLLAPSE_DURATION_MS}ms ease-in-out`;
    el.style.height = '0px';
    el.style.opacity = '0';

    const timer = setTimeout(() => {
      setCollapsed(true);
      el.style.transition = '';
      el.style.height = '';
      el.style.opacity = '';
    }, COLLAPSE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [chunk.reviewed]);

  // Handle expand animation after collapsed becomes false
  useEffect(() => {
    if (chunk.reviewed || collapsed) return;
    const el = contentRef.current;
    if (!el) return;

    // Start at 0 height
    el.style.height = '0px';
    el.style.opacity = '0';
    el.style.overflow = 'hidden';
    el.style.transition = 'none';
    void el.offsetHeight;

    const targetHeight = el.scrollHeight;
    el.style.transition = `height ${COLLAPSE_DURATION_MS}ms ease-in-out, opacity ${COLLAPSE_DURATION_MS}ms ease-in-out`;
    el.style.height = `${targetHeight}px`;
    el.style.opacity = '1';

    const timer = setTimeout(() => {
      el.style.transition = '';
      el.style.height = '';
      el.style.opacity = '';
      el.style.overflow = '';
    }, COLLAPSE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [collapsed, chunk.reviewed]);

  /**
   * Determine the effective line number for a diff line.
   * For add/context lines, use newLineNum. For del lines, use the newLineNum
   * of the next non-del line (or fallback to old line).
   * This gives us a "right-side" anchor for comments.
   */
  function getCommentLine(parsed: ParsedDiffLine): number {
    // For lines with a new-file line number, use it directly
    if (parsed.newLineNum != null) return parsed.newLineNum;
    // For deleted lines, use the old line number as fallback
    if (parsed.oldLineNum != null) return parsed.oldLineNum;
    return 0;
  }

  return (
    <div
      className="transition-opacity duration-300"
      style={{ opacity: chunk.reviewed && collapsed ? 0.6 : 1 }}
    >
      <ChunkHeader chunk={chunk} onToggle={onToggleReviewed} isLast={isLast} />
      {!collapsed && (
        <div ref={contentRef} className="overflow-hidden">
          {chunk.metadata?.reviewNote && <ReviewNote note={chunk.metadata.reviewNote} />}
          <div className="font-mono">
            {parsedLines.map((parsed, i) => {
              const lineNum = getCommentLine(parsed);
              const threadsForLine = threadsByLine.get(lineNum);
              const showForm = commentFormLine != null && commentFormLine === lineNum;

              return (
                <div key={`${chunk.id}-line-${i}`}>
                  <DiffLine
                    parsed={parsed}
                    onClickAdd={
                      parsed.type !== 'hunk-header' && parsed.type !== 'empty'
                        ? () => setCommentFormLine(lineNum)
                        : undefined
                    }
                  />
                  {/* Render threads anchored to this line */}
                  {threadsForLine?.map((thread) => (
                    <InlineThread
                      key={thread.root.id}
                      thread={thread}
                      onReply={onReplyComment}
                      onUpdate={onUpdateComment}
                      onDelete={onDeleteComment}
                      onPublish={onPublishComment}
                      onResolve={onResolveThread}
                      onUnresolve={onUnresolveThread}
                    />
                  ))}
                  {/* New comment form for this line */}
                  {showForm && (
                    <NewCommentForm
                      onAdd={async (body) => {
                        await onAddComment(body, lineNum);
                        setCommentFormLine(null);
                      }}
                      onCancel={() => setCommentFormLine(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── File Box ────────────────────────────────────────────────

function FileBox({
  group,
  onToggleReviewed,
  onAddComment,
  onReplyComment,
  onUpdateComment,
  onDeleteComment,
  onPublishComment,
  onResolveThread,
  onUnresolveThread,
}: {
  group: FileGroup;
  onToggleReviewed: (chunkId: number) => void;
  onAddComment: (chunkId: number, body: string, line: number) => Promise<void>;
  onReplyComment: (chunkId: number, parentId: number, body: string) => Promise<void>;
  onUpdateComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onPublishComment: (commentId: number) => Promise<void>;
  onResolveThread: (commentId: number) => Promise<void>;
  onUnresolveThread: (commentId: number) => Promise<void>;
}): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-lg border border-border-primary bg-surface-primary">
      {/* File header — sticky within file box */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-primary bg-surface-secondary px-4 py-2">
        <span className="font-mono text-xs text-fg-primary font-medium">{group.filePath}</span>
        <span className="text-xs text-fg-muted">
          ({group.chunks.length} chunk{group.chunks.length !== 1 ? 's' : ''})
        </span>
        {group.allReviewed && <span className="text-xs text-success-fg">✓ All reviewed</span>}
      </div>

      {/* Chunks */}
      {group.chunks.map((chunk, i) => (
        <ChunkBlock
          key={chunk.id}
          chunk={chunk}
          onToggleReviewed={() => onToggleReviewed(chunk.id)}
          onAddComment={(body, line) => onAddComment(chunk.id, body, line)}
          onReplyComment={(parentId, body) => onReplyComment(chunk.id, parentId, body)}
          onUpdateComment={onUpdateComment}
          onDeleteComment={onDeleteComment}
          onPublishComment={onPublishComment}
          onResolveThread={onResolveThread}
          onUnresolveThread={onUnresolveThread}
          isLast={i === group.chunks.length - 1}
        />
      ))}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────

export const DiffViewer = memo(function DiffViewer({
  chunks,
  onToggleReviewed,
  onAddComment,
  onReplyComment,
  onUpdateComment,
  onDeleteComment,
  onPublishComment,
  onResolveThread,
  onUnresolveThread,
}: DiffViewerProps): React.ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);

  // Group chunks by file, each group becomes one virtual row (file box)
  const fileGroups = useMemo((): FileGroup[] => {
    const map = new Map<string, ChunkWithDetails[]>();
    for (const chunk of chunks) {
      const existing = map.get(chunk.filePath);
      if (existing) {
        existing.push(chunk);
      } else {
        map.set(chunk.filePath, [chunk]);
      }
    }

    const result: FileGroup[] = [];
    for (const [filePath, fileChunks] of map) {
      const sorted = fileChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      result.push({
        filePath,
        chunks: sorted,
        allReviewed: sorted.every((c) => c.reviewed),
      });
    }
    return result;
  }, [chunks]);

  // Estimate file box height: header ~36px + each chunk varies
  const estimateSize = useCallback(
    (index: number): number => {
      const group = fileGroups[index];
      let height = 36; // file header
      for (const chunk of group.chunks) {
        if (chunk.reviewed) {
          height += 32; // collapsed chunk header
        } else {
          const lineCount = chunk.diffText.split('\n').length;
          const noteHeight = chunk.metadata?.reviewNote ? 28 : 0;
          // chunk header + note + diff lines + comment area
          height += 32 + noteHeight + lineCount * 20 + 40;
        }
      }
      return height + 32; // bottom margin between file boxes
    },
    [fileGroups],
  );

  const virtualizer = useVirtualizer({
    count: fileGroups.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: 3,
  });

  return (
    <div ref={parentRef} className="h-full overflow-y-auto bg-surface-page p-4">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
              paddingBottom: '16px', // gap between file boxes
            }}
          >
            <FileBox
              group={fileGroups[virtualRow.index]}
              onToggleReviewed={onToggleReviewed}
              onAddComment={onAddComment}
              onReplyComment={onReplyComment}
              onUpdateComment={onUpdateComment}
              onDeleteComment={onDeleteComment}
              onPublishComment={onPublishComment}
              onResolveThread={onResolveThread}
              onUnresolveThread={onUnresolveThread}
            />
          </div>
        ))}
      </div>
    </div>
  );
});
