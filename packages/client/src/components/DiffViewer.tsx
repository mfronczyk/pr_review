/**
 * DiffViewer – renders diff chunks grouped by file in bordered boxes (like GitHub PRs).
 * Each file is a rounded container with a sticky header and all its chunks inside.
 * Uses @tanstack/react-virtual for efficient rendering of large PRs.
 *
 * Comments are anchored to specific lines within chunks (LEFT for deleted lines,
 * RIGHT for added/context lines) and rendered inline as threads (root + flat replies).
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getContextLines } from '@/api';
import { InlineThread, NewCommentForm } from '@/components/InlineComment';
import { Markdown } from '@/components/Markdown';
import { highlightLines } from '@/highlight';
import type { ChunkWithDetails, Comment, CommentThread } from '@pr-review/shared';

// ── Types ───────────────────────────────────────────────────

interface DiffViewerProps {
  chunks: ChunkWithDetails[];
  departingChunkIds: ReadonlySet<number>;
  scrollToFile: string | null;
  /** When true, long lines wrap instead of being clipped. */
  wrapLines?: boolean;
  /** Optional content rendered at the top of the scroll area (scrolls away with the diff). */
  headerContent?: React.ReactNode;
  onToggleApproved: (chunkId: number) => void;
  onChunkDeparted: (chunkId: number) => void;
  onScrollToFileDone: () => void;
  onAddComment: (
    chunkId: number,
    body: string,
    line: number,
    side: 'LEFT' | 'RIGHT',
  ) => Promise<void>;
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
  allApproved: boolean;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Group a flat Comment[] into threads keyed by "line:side" (e.g. "42:RIGHT").
 * Returns a Map from the composite key to CommentThread[].
 */
function groupCommentsIntoThreads(comments: Comment[]): Map<string, CommentThread[]> {
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

  const byKey = new Map<string, CommentThread[]>();
  for (const root of roots) {
    const replies = repliesByParent.get(root.id) ?? [];
    const thread: CommentThread = { root, replies };
    const key = `${root.line}:${root.side}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      byKey.set(key, [thread]);
    }
  }
  return byKey;
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
  isFooter = false,
}: {
  chunk: ChunkWithDetails;
  onToggle: () => void;
  isLast: boolean;
  isFooter?: boolean;
}): React.ReactElement {
  const commentCount = chunk.comments.length;
  return (
    <div
      className={`flex items-center gap-2 border-t border-border-secondary bg-surface-secondary px-3 py-1.5 ${
        chunk.approved && isLast ? '' : ''
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border text-xs ${
          chunk.approved
            ? 'border-green-600 bg-green-600 text-white'
            : 'border-fg-faint bg-transparent text-transparent hover:border-fg-tertiary'
        }`}
        title={chunk.approved ? 'Mark unapproved' : 'Mark approved'}
      >
        {chunk.approved ? '✓' : ''}
      </button>

      <span className="text-xs text-fg-muted">
        L{chunk.startLine}–{chunk.endLine}
      </span>

      {!isFooter && chunk.metadata?.priority && (
        <PriorityBadge priority={chunk.metadata.priority} />
      )}

      {commentCount > 0 && (
        <span className="text-xs text-fg-muted">
          {commentCount} comment{commentCount !== 1 ? 's' : ''}
        </span>
      )}

      {chunk.approved && <span className="ml-auto text-[10px] text-success-fg">Approved</span>}
    </div>
  );
}

// ── Review Note ─────────────────────────────────────────────

function ReviewNote({ note }: { note: string }): React.ReactElement {
  return (
    <div className="border-t border-border-secondary px-3 py-1">
      <div className="max-w-3xl rounded bg-diff-note-bg px-2 py-0.5 text-xs text-diff-note-fg">
        <span className="mr-1">⚡</span>
        <Markdown text={note} compact className="inline" />
      </div>
    </div>
  );
}

// ── Expand Context ──────────────────────────────────────────

/** Tracks expanded context state for a single chunk. */
interface ExpandedContext {
  above: ParsedDiffLine[];
  below: ParsedDiffLine[];
  /** The lowest new-side line number loaded above the chunk. */
  topLine: number;
  /** The highest new-side line number loaded below the chunk. */
  bottomLine: number;
  topExhausted: boolean;
  bottomExhausted: boolean;
  loadingAbove: boolean;
  loadingBelow: boolean;
}

const EXPAND_LINES = 20;

function ExpandButton({
  direction,
  loading,
  onClick,
}: {
  direction: 'above' | 'below';
  loading: boolean;
  onClick: () => void;
}): React.ReactElement {
  const arrow = direction === 'above' ? '\u2191' : '\u2193';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="flex w-full items-center justify-center gap-1 border-t border-border-secondary bg-diff-info-bg/20 py-0.5 text-xs text-diff-info-fg hover:bg-diff-info-bg/40 disabled:opacity-50"
    >
      {loading ? (
        'Loading...'
      ) : (
        <>
          {arrow} Show {EXPAND_LINES} more lines
        </>
      )}
    </button>
  );
}

// ── Line Number Parsing ─────────────────────────────────────

interface ParsedDiffLine {
  type: 'context' | 'add' | 'del' | 'hunk-header';
  /** The line content without the diff prefix (+/-/space). */
  content: string;
  /** The diff prefix character: '+', '-', ' ', or '' for hunk headers. */
  prefix: string;
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
      result.push({
        type: 'hunk-header',
        content: line,
        prefix: '',
        oldLineNum: null,
        newLineNum: null,
      });
    } else if (line.startsWith('+')) {
      result.push({
        type: 'add',
        content: line.slice(1),
        prefix: '+',
        oldLineNum: null,
        newLineNum: newLine,
      });
      newLine++;
    } else if (line.startsWith('-')) {
      result.push({
        type: 'del',
        content: line.slice(1),
        prefix: '-',
        oldLineNum: oldLine,
        newLineNum: null,
      });
      oldLine++;
    } else if (line.startsWith(' ')) {
      // Context line with explicit space prefix
      result.push({
        type: 'context',
        content: line.slice(1),
        prefix: ' ',
        oldLineNum: oldLine,
        newLineNum: newLine,
      });
      oldLine++;
      newLine++;
    } else if (line === '') {
      // Blank line in source code (git sometimes omits the leading space)
      result.push({
        type: 'context',
        content: '',
        prefix: ' ',
        oldLineNum: oldLine,
        newLineNum: newLine,
      });
      oldLine++;
      newLine++;
    } else {
      // Other content (shouldn't happen in well-formed diffs)
      result.push({
        type: 'context',
        content: line,
        prefix: ' ',
        oldLineNum: oldLine,
        newLineNum: newLine,
      });
      oldLine++;
      newLine++;
    }
  }

  // Remove trailing empty context lines (artifact of splitting on trailing \n)
  while (
    result.length > 0 &&
    result[result.length - 1].type === 'context' &&
    result[result.length - 1].content === '' &&
    result[result.length - 1].prefix === ' '
  ) {
    // Only pop if it's the very last line (trailing newline artifact)
    const last = result[result.length - 1];
    if (last.oldLineNum != null && last.newLineNum != null) {
      result.pop();
    } else {
      break;
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
};

const gutterStyles: Record<ParsedDiffLine['type'], string> = {
  add: 'bg-diff-add-gutter text-diff-add-fg/60',
  del: 'bg-diff-del-gutter text-diff-del-fg/60',
  'hunk-header': 'bg-diff-info-bg/30 text-diff-info-fg/50',
  context: 'text-fg-muted',
};

function DiffLine({
  parsed,
  highlightedHtml,
  wrapLines,
  onClickAdd,
}: {
  parsed: ParsedDiffLine;
  highlightedHtml: string | null;
  wrapLines?: boolean;
  onClickAdd?: () => void;
}): React.ReactElement {
  const { bg, text } = lineStyles[parsed.type];
  const gutter = gutterStyles[parsed.type];
  const canComment = parsed.type !== 'hunk-header';
  const ws = wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre';

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
      {/* Diff prefix (+/-/space) — fixed width so code stays aligned */}
      <span
        className={`inline-block w-5 flex-shrink-0 select-none pl-1 font-mono text-xs leading-5 ${text}`}
      >
        {parsed.prefix}
      </span>
      {/* Code content */}
      {highlightedHtml != null ? (
        <code
          className={`hljs min-w-0 flex-1 ${ws} pr-3 text-xs leading-5 ${parsed.type === 'hunk-header' ? text : ''}`}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output is trusted
          dangerouslySetInnerHTML={{ __html: highlightedHtml || '&nbsp;' }}
        />
      ) : (
        <code className={`min-w-0 flex-1 ${ws} pr-3 text-xs leading-5 ${text}`}>
          {parsed.content || ' '}
        </code>
      )}
    </div>
  );
}

// ── Chunk Block ─────────────────────────────────────────────

/**
 * Extract the first new-side line number from parsed diff lines.
 * This is the line number at the top of the hunk, used to determine
 * how far above the chunk we can expand.
 */
function getFirstNewLineNum(parsedLines: ParsedDiffLine[]): number {
  for (const line of parsedLines) {
    if (line.newLineNum != null) return line.newLineNum;
  }
  return 1;
}

/**
 * Extract the last new-side line number from parsed diff lines.
 * This is the line number at the bottom of the hunk, used to determine
 * where to start expanding below.
 */
function getLastNewLineNum(parsedLines: ParsedDiffLine[]): number {
  for (let i = parsedLines.length - 1; i >= 0; i--) {
    const num = parsedLines[i].newLineNum;
    if (num != null) return num;
  }
  return 1;
}

function ChunkBlock({
  chunk,
  wrapLines,
  onToggleApproved,
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
  wrapLines?: boolean;
  onToggleApproved: () => void;
  onAddComment: (body: string, line: number, side: 'LEFT' | 'RIGHT') => Promise<void>;
  onReplyComment: (parentId: number, body: string) => Promise<void>;
  onUpdateComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onPublishComment: (commentId: number) => Promise<void>;
  onResolveThread: (commentId: number) => Promise<void>;
  onUnresolveThread: (commentId: number) => Promise<void>;
  isLast: boolean;
}): React.ReactElement {
  const parsedLines = useMemo(() => parseDiffLines(chunk.diffText), [chunk.diffText]);

  // ── Expanded context state ──────────────────────────────
  const [expanded, setExpanded] = useState<ExpandedContext>(() => {
    const firstLine = getFirstNewLineNum(parsedLines);
    const lastLine = getLastNewLineNum(parsedLines);
    return {
      above: [],
      below: [],
      topLine: firstLine,
      bottomLine: lastLine,
      topExhausted: firstLine <= 1,
      bottomExhausted: false,
      loadingAbove: false,
      loadingBelow: false,
    };
  });

  // Reset expanded context when the chunk's diff text changes
  useEffect(() => {
    const firstLine = getFirstNewLineNum(parsedLines);
    const lastLine = getLastNewLineNum(parsedLines);
    setExpanded({
      above: [],
      below: [],
      topLine: firstLine,
      bottomLine: lastLine,
      topExhausted: firstLine <= 1,
      bottomExhausted: false,
      loadingAbove: false,
      loadingBelow: false,
    });
  }, [parsedLines]);

  const handleExpandAbove = useCallback(async () => {
    setExpanded((prev) => ({ ...prev, loadingAbove: true }));
    try {
      const endLine = expanded.topLine - 1;
      const startLine = Math.max(1, endLine - EXPAND_LINES + 1);
      if (endLine < 1) {
        setExpanded((prev) => ({ ...prev, topExhausted: true, loadingAbove: false }));
        return;
      }
      const { lines } = await getContextLines(chunk.prId, chunk.filePath, startLine, endLine);
      const newLines: ParsedDiffLine[] = lines.map((l) => ({
        type: 'context' as const,
        content: l.content,
        prefix: ' ',
        oldLineNum: l.lineNumber,
        newLineNum: l.lineNumber,
      }));
      setExpanded((prev) => ({
        ...prev,
        above: [...newLines, ...prev.above],
        topLine: startLine,
        topExhausted: startLine <= 1,
        loadingAbove: false,
      }));
    } catch {
      setExpanded((prev) => ({ ...prev, loadingAbove: false }));
    }
  }, [expanded.topLine, chunk.prId, chunk.filePath]);

  const handleExpandBelow = useCallback(async () => {
    setExpanded((prev) => ({ ...prev, loadingBelow: true }));
    try {
      const startLine = expanded.bottomLine + 1;
      const endLine = startLine + EXPAND_LINES - 1;
      const { lines } = await getContextLines(chunk.prId, chunk.filePath, startLine, endLine);
      if (lines.length === 0) {
        setExpanded((prev) => ({ ...prev, bottomExhausted: true, loadingBelow: false }));
        return;
      }
      const newLines: ParsedDiffLine[] = lines.map((l) => ({
        type: 'context' as const,
        content: l.content,
        prefix: ' ',
        oldLineNum: l.lineNumber,
        newLineNum: l.lineNumber,
      }));
      setExpanded((prev) => ({
        ...prev,
        below: [...prev.below, ...newLines],
        bottomLine: lines[lines.length - 1].lineNumber,
        bottomExhausted: lines.length < EXPAND_LINES,
        loadingBelow: false,
      }));
    } catch {
      setExpanded((prev) => ({ ...prev, loadingBelow: false }));
    }
  }, [expanded.bottomLine, chunk.prId, chunk.filePath]);

  // ── Combined lines for rendering and highlighting ───────
  const allLines = useMemo(
    () => [...expanded.above, ...parsedLines, ...expanded.below],
    [expanded.above, parsedLines, expanded.below],
  );

  // Compute syntax-highlighted HTML for each line.
  // We highlight all code lines together (preserving multi-line token state)
  // and then map the results back to each parsed line.
  const highlightedHtmlLines = useMemo((): (string | null)[] => {
    const codeLines = allLines.map((p) => (p.type === 'hunk-header' ? '' : p.content));
    const highlighted = highlightLines(chunk.filePath, codeLines);
    return allLines.map((p, i) => (p.type === 'hunk-header' ? null : highlighted[i]));
  }, [allLines, chunk.filePath]);

  // Track which diff line index the comment form is open for (null = closed).
  // We use the array index (not line number) because multiple diff lines can
  // share the same line number (e.g. a deletion followed by an addition).
  const [commentFormIndex, setCommentFormIndex] = useState<number | null>(null);

  // Group comments into threads by line
  const threadsByLine = useMemo(() => groupCommentsIntoThreads(chunk.comments), [chunk.comments]);

  /**
   * Determine the effective line number and diff side for a diff line.
   * - del lines → oldLineNum on LEFT (old-file side)
   * - add/context lines → newLineNum on RIGHT (new-file side)
   */
  function getCommentAnchor(parsed: ParsedDiffLine): {
    line: number;
    side: 'LEFT' | 'RIGHT';
  } {
    if (parsed.type === 'del' && parsed.oldLineNum != null) {
      return { line: parsed.oldLineNum, side: 'LEFT' };
    }
    if (parsed.newLineNum != null) {
      return { line: parsed.newLineNum, side: 'RIGHT' };
    }
    if (parsed.oldLineNum != null) {
      return { line: parsed.oldLineNum, side: 'LEFT' };
    }
    return { line: 0, side: 'RIGHT' };
  }

  const dimClass = chunk.approved ? 'opacity-50' : '';

  return (
    <div>
      <div className={dimClass}>
        <ChunkHeader chunk={chunk} onToggle={onToggleApproved} isLast={isLast} />
      </div>
      <div className="overflow-hidden">
        {chunk.metadata?.reviewNote && (
          <div className={dimClass}>
            <ReviewNote note={chunk.metadata.reviewNote} />
          </div>
        )}
        {/* Expand above button */}
        {!expanded.topExhausted && (
          <ExpandButton
            direction="above"
            loading={expanded.loadingAbove}
            onClick={handleExpandAbove}
          />
        )}
        <div className="font-mono">
          {allLines.map((parsed, i) => {
            const anchor = getCommentAnchor(parsed);
            const threadKey = `${anchor.line}:${anchor.side}`;
            const threadsForLine = threadsByLine.get(threadKey);
            const showForm = commentFormIndex === i;

            return (
              <div key={`${chunk.id}-line-${i}`}>
                <div className={dimClass}>
                  <DiffLine
                    parsed={parsed}
                    highlightedHtml={highlightedHtmlLines[i]}
                    wrapLines={wrapLines}
                    onClickAdd={
                      parsed.type !== 'hunk-header' ? () => setCommentFormIndex(i) : undefined
                    }
                  />
                </div>
                {/* Render threads anchored to this line — always full opacity */}
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
                {/* New comment form for this line — always full opacity */}
                {showForm && (
                  <NewCommentForm
                    onAdd={async (body) => {
                      await onAddComment(body, anchor.line, anchor.side);
                      setCommentFormIndex(null);
                    }}
                    onCancel={() => setCommentFormIndex(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
        {/* Expand below button */}
        {!expanded.bottomExhausted && (
          <ExpandButton
            direction="below"
            loading={expanded.loadingBelow}
            onClick={handleExpandBelow}
          />
        )}
      </div>

      {/* Footer — mirrors ChunkHeader, dimmed when approved */}
      <div className={dimClass}>
        <ChunkHeader chunk={chunk} onToggle={onToggleApproved} isLast={isLast} isFooter />
      </div>
    </div>
  );
}

// ── Animated Chunk Wrapper ──────────────────────────────────

const DEPART_DURATION_MS = 300;

/**
 * Wraps a chunk in a container that animates fade+collapse when departing.
 * After the transition completes, calls onDeparted so the chunk can be
 * removed from the list.
 */
function AnimatedChunkWrapper({
  chunkId,
  isDeparting,
  onDeparted,
  children,
  className,
}: {
  chunkId: number;
  isDeparting: boolean;
  onDeparted: (chunkId: number) => void;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [animating, setAnimating] = useState(false);

  // Reset inline styles if departing is cancelled (e.g. hideApproved toggled off)
  useEffect(() => {
    if (!isDeparting && animating) {
      const el = wrapperRef.current;
      if (el) {
        el.style.transition = '';
        el.style.opacity = '';
        el.style.height = '';
        el.style.marginTop = '';
        el.style.overflow = '';
      }
      setAnimating(false);
    }
  }, [isDeparting, animating]);

  useEffect(() => {
    if (!isDeparting || animating) return;

    const el = wrapperRef.current;
    if (!el) {
      onDeparted(chunkId);
      return;
    }

    // Capture current height then trigger collapse
    const height = el.scrollHeight;
    el.style.height = `${height}px`;
    el.style.opacity = '1';

    // Force reflow so the browser registers the starting values
    el.offsetHeight; // eslint-disable-line no-unused-expressions

    setAnimating(true);

    // Start the transition
    requestAnimationFrame(() => {
      el.style.transition = `opacity ${DEPART_DURATION_MS}ms ease, height ${DEPART_DURATION_MS}ms ease, margin ${DEPART_DURATION_MS}ms ease`;
      el.style.opacity = '0';
      el.style.height = '0px';
      el.style.marginTop = '0px';
      el.style.overflow = 'hidden';
    });

    const timer = setTimeout(() => {
      onDeparted(chunkId);
    }, DEPART_DURATION_MS + 50);

    return () => clearTimeout(timer);
  }, [isDeparting, chunkId, onDeparted, animating]);

  return (
    <div ref={wrapperRef} className={className}>
      {children}
    </div>
  );
}

// ── File Box ────────────────────────────────────────────────

function FileBox({
  group,
  wrapLines,
  departingChunkIds,
  onToggleApproved,
  onChunkDeparted,
  onAddComment,
  onReplyComment,
  onUpdateComment,
  onDeleteComment,
  onPublishComment,
  onResolveThread,
  onUnresolveThread,
}: {
  group: FileGroup;
  wrapLines?: boolean;
  departingChunkIds: ReadonlySet<number>;
  onToggleApproved: (chunkId: number) => void;
  onChunkDeparted: (chunkId: number) => void;
  onAddComment: (
    chunkId: number,
    body: string,
    line: number,
    side: 'LEFT' | 'RIGHT',
  ) => Promise<void>;
  onReplyComment: (chunkId: number, parentId: number, body: string) => Promise<void>;
  onUpdateComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onPublishComment: (commentId: number) => Promise<void>;
  onResolveThread: (commentId: number) => Promise<void>;
  onUnresolveThread: (commentId: number) => Promise<void>;
}): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-lg border border-border-primary bg-surface-primary">
      {/* File header */}
      <div className="flex items-center gap-2 border-b border-border-primary bg-surface-secondary px-4 pt-4 pb-2">
        <span className="font-mono text-xs text-fg-primary font-medium">{group.filePath}</span>
        <span className="text-xs text-fg-muted">
          ({group.chunks.length} chunk{group.chunks.length !== 1 ? 's' : ''})
        </span>
        {group.allApproved && <span className="text-xs text-success-fg">✓ All approved</span>}
      </div>

      {/* Chunks */}
      {group.chunks.map((chunk, i) => (
        <AnimatedChunkWrapper
          key={chunk.id}
          chunkId={chunk.id}
          isDeparting={departingChunkIds.has(chunk.id)}
          onDeparted={onChunkDeparted}
          className={i > 0 ? 'mt-3' : ''}
        >
          <ChunkBlock
            chunk={chunk}
            wrapLines={wrapLines}
            onToggleApproved={() => onToggleApproved(chunk.id)}
            onAddComment={(body, line, side) => onAddComment(chunk.id, body, line, side)}
            onReplyComment={(parentId, body) => onReplyComment(chunk.id, parentId, body)}
            onUpdateComment={onUpdateComment}
            onDeleteComment={onDeleteComment}
            onPublishComment={onPublishComment}
            onResolveThread={onResolveThread}
            onUnresolveThread={onUnresolveThread}
            isLast={i === group.chunks.length - 1}
          />
        </AnimatedChunkWrapper>
      ))}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────

export const DiffViewer = memo(function DiffViewer({
  chunks,
  departingChunkIds,
  scrollToFile,
  wrapLines,
  headerContent,
  onToggleApproved,
  onChunkDeparted,
  onScrollToFileDone,
  onAddComment,
  onReplyComment,
  onUpdateComment,
  onDeleteComment,
  onPublishComment,
  onResolveThread,
  onUnresolveThread,
}: DiffViewerProps): React.ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

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
        allApproved: sorted.every((c) => c.approved),
      });
    }
    // Sort file groups: directories before files at each level, alphabetical within.
    // This matches the sidebar file tree ordering and GitHub's diff view.
    result.sort((a, b) => {
      const aParts = a.filePath.split('/');
      const bParts = b.filePath.split('/');
      const minLen = Math.min(aParts.length, bParts.length);
      for (let i = 0; i < minLen; i++) {
        const aIsLast = i === aParts.length - 1;
        const bIsLast = i === bParts.length - 1;
        // If one is a file and the other is a directory at this level,
        // the directory (deeper path) comes first
        if (aIsLast !== bIsLast) return aIsLast ? 1 : -1;
        const cmp = aParts[i].localeCompare(bParts[i]);
        if (cmp !== 0) return cmp;
      }
      return aParts.length - bParts.length;
    });
    return result;
  }, [chunks]);

  // Estimate file box height: header ~36px + each chunk's full content
  const estimateSize = useCallback(
    (index: number): number => {
      const group = fileGroups[index];
      let height = 36; // file header
      for (const chunk of group.chunks) {
        const lineCount = chunk.diffText.split('\n').length;
        const noteHeight = chunk.metadata?.reviewNote ? 28 : 0;
        // chunk header + note + diff lines + comment area
        height += 32 + noteHeight + lineCount * 20 + 40;
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

  // When wrapLines changes, previously-measured row heights become stale.
  // Force the virtualizer to re-measure all items.
  // biome-ignore lint/correctness/useExhaustiveDependencies: wrapLines triggers remeasure even though it's not read inside the effect
  useEffect(() => {
    virtualizer.measure();
  }, [wrapLines, virtualizer]);

  // Scroll to top when the set of file groups changes (e.g. switching tag groups).
  // Compare by file-path list so that approval toggles (which create new fileGroups
  // references but keep the same files) don't trigger a scroll reset.
  const fileGroupKey = useMemo(() => fileGroups.map((g) => g.filePath).join('\0'), [fileGroups]);
  const prevFileGroupKeyRef = useRef(fileGroupKey);
  useEffect(() => {
    if (prevFileGroupKeyRef.current !== fileGroupKey) {
      prevFileGroupKeyRef.current = fileGroupKey;
      if (parentRef.current) {
        parentRef.current.scrollTop = 0;
      }
    }
  }, [fileGroupKey]);

  // Scroll to a specific file group when requested.
  // We manually calculate the offset to account for the header content above the virtualized area.
  useEffect(() => {
    if (!scrollToFile) return;
    const index = fileGroups.findIndex((g) => g.filePath === scrollToFile);
    if (index >= 0) {
      const result = virtualizer.getOffsetForIndex(index, 'start');
      if (result) {
        const headerOffset = headerRef.current?.offsetHeight ?? 0;
        virtualizer.scrollToOffset(result[0] + headerOffset);
      }
    }
    onScrollToFileDone();
  }, [scrollToFile, fileGroups, virtualizer, onScrollToFileDone]);

  // ── Sticky file-name overlay ──────────────────────────────
  // Tracks which file is at the top of the viewport and shows a pinned
  // header bar (like GitHub) that sits flush with the toolbar.  When the
  // next file's inline header approaches, the overlay slides up to make
  // room — no abrupt pop-in/pop-out.
  const stickyRef = useRef<HTMLDivElement>(null);
  const [stickyFile, setStickyFile] = useState<FileGroup | null>(null);
  const [stickyOffset, setStickyOffset] = useState(0); // negative translateY when being pushed

  useEffect(() => {
    const scrollEl = parentRef.current;
    if (!scrollEl) return;

    function handleScroll(): void {
      const items = virtualizer.getVirtualItems();
      if (items.length === 0) {
        setStickyFile(null);
        setStickyOffset(0);
        return;
      }

      const scrollTop = scrollEl?.scrollTop ?? 0;
      const headerHeight = headerRef.current?.offsetHeight ?? 0;
      // Virtual item offsets are relative to the virtualizer container which
      // starts after headerContent + the scroll container's top padding (p-4).
      const containerOffset = headerHeight + 16; // 16px = p-4

      // Total height of the sticky overlay (inner bar).
      const overlayHeight = stickyRef.current?.offsetHeight ?? 36;

      // Find the last file whose inline header's rounded top corners have
      // scrolled past the viewport top.  The overlay appears to seamlessly
      // cover the remaining flat portion of the inline header that is still
      // visible.  The FileBox container uses rounded-lg (8px border-radius)
      // plus ~1px border, so we use ~10px as the trigger threshold.
      const cornerThreshold = 10;
      let found: number | null = null;
      for (const item of items) {
        const rowTop = item.start + containerOffset;
        if (rowTop + cornerThreshold <= scrollTop) {
          found = item.index;
        }
      }

      if (found !== null) {
        const group = fileGroups[found];
        // Where the *next* file row starts (the incoming inline header).
        const nextStart =
          found + 1 < fileGroups.length
            ? (virtualizer.getOffsetForIndex(found + 1, 'start')?.[0] ?? virtualizer.getTotalSize())
            : virtualizer.getTotalSize();
        const nextRowTop = nextStart + containerOffset;

        // Distance from the top of the viewport to the incoming header.
        const distanceToNext = nextRowTop - scrollTop;

        if (distanceToNext <= 0) {
          // The next file's header is at or above the viewport top —
          // the current file is fully scrolled out.
          setStickyFile(null);
          setStickyOffset(0);
        } else if (distanceToNext < overlayHeight) {
          // The incoming header is pushing the overlay upward.
          setStickyFile(group ?? null);
          setStickyOffset(distanceToNext - overlayHeight); // negative value
        } else {
          // Plenty of room — overlay sits at its natural position.
          setStickyFile(group ?? null);
          setStickyOffset(0);
        }
      } else {
        setStickyFile(null);
        setStickyOffset(0);
      }
    }

    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => scrollEl.removeEventListener('scroll', handleScroll);
  }, [virtualizer, fileGroups]);

  return (
    <div className="relative h-full overflow-hidden">
      {/* Sticky overlay — appears when a file header touches the top edge.
          Matches the inline file header width/style. Slides up when the
          next file's inline header approaches. */}
      {stickyFile && (
        <div
          className="absolute right-0 left-0 z-30 px-4 pointer-events-none"
          style={{
            top: '-10px',
            transform: stickyOffset < 0 ? `translateY(${stickyOffset}px)` : undefined,
          }}
        >
          <div
            ref={stickyRef}
            className="pointer-events-auto flex items-center gap-2 rounded-t-lg border border-border-primary bg-surface-secondary px-4 pt-4 pb-2"
          >
            <span className="font-mono text-xs text-fg-primary font-medium">
              {stickyFile.filePath}
            </span>
            <span className="text-xs text-fg-muted">
              ({stickyFile.chunks.length} chunk{stickyFile.chunks.length !== 1 ? 's' : ''})
            </span>
            {stickyFile.allApproved && (
              <span className="text-xs text-success-fg">✓ All approved</span>
            )}
          </div>
        </div>
      )}

      <div ref={parentRef} className="h-full overflow-y-auto bg-surface-page p-4">
        {headerContent && <div ref={headerRef}>{headerContent}</div>}
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
                wrapLines={wrapLines}
                departingChunkIds={departingChunkIds}
                onToggleApproved={onToggleApproved}
                onChunkDeparted={onChunkDeparted}
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
    </div>
  );
});
