/**
 * DiffViewer – renders diff chunks grouped by file in bordered boxes (like GitHub PRs).
 * Each file is a rounded container with a sticky header and all its chunks inside.
 * Uses @tanstack/react-virtual for efficient rendering of large PRs.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useRef } from 'react';

import { InlineComment } from '@/components/InlineComment';
import type { ChunkWithDetails } from '@pr-review/shared';

// ── Types ───────────────────────────────────────────────────

interface DiffViewerProps {
  chunks: ChunkWithDetails[];
  onToggleReviewed: (chunkId: number) => void;
  onAddComment: (chunkId: number, body: string) => Promise<void>;
  onUpdateComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onPublishComment: (commentId: number) => Promise<void>;
}

/** Each virtual row is one file group (header + all chunks). */
interface FileGroup {
  filePath: string;
  chunks: ChunkWithDetails[];
  allReviewed: boolean;
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

      {chunk.comments.length > 0 && (
        <span className="text-xs text-fg-muted">
          {chunk.comments.length} comment{chunk.comments.length !== 1 ? 's' : ''}
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

// ── Diff Line ───────────────────────────────────────────────

function DiffLine({ line }: { line: string }): React.ReactElement {
  let bgClass = '';
  let textClass = 'text-fg-secondary';

  if (line.startsWith('+')) {
    bgClass = 'bg-diff-add-bg/40';
    textClass = 'text-diff-add-fg';
  } else if (line.startsWith('-')) {
    bgClass = 'bg-diff-del-bg/40';
    textClass = 'text-diff-del-fg';
  } else if (line.startsWith('@@')) {
    bgClass = 'bg-diff-info-bg/30';
    textClass = 'text-diff-info-fg';
  }

  return (
    <div className={`px-3 ${bgClass}`}>
      <code className={`text-xs leading-5 ${textClass}`}>{line || ' '}</code>
    </div>
  );
}

// ── Chunk Block ─────────────────────────────────────────────

function ChunkBlock({
  chunk,
  onToggleReviewed,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  onPublishComment,
  isLast,
}: {
  chunk: ChunkWithDetails;
  onToggleReviewed: () => void;
  onAddComment: (body: string) => Promise<void>;
  onUpdateComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onPublishComment: (commentId: number) => Promise<void>;
  isLast: boolean;
}): React.ReactElement {
  const lines = chunk.diffText.split('\n');

  // Collapsed view for reviewed chunks
  if (chunk.reviewed) {
    return (
      <div className="opacity-60">
        <ChunkHeader chunk={chunk} onToggle={onToggleReviewed} isLast={isLast} />
      </div>
    );
  }

  return (
    <div>
      <ChunkHeader chunk={chunk} onToggle={onToggleReviewed} isLast={isLast} />
      {chunk.metadata?.reviewNote && <ReviewNote note={chunk.metadata.reviewNote} />}
      <div className="font-mono">
        {lines.map((line, i) => (
          <DiffLine key={`${chunk.id}-${i}`} line={line} />
        ))}
      </div>
      <InlineComment
        comments={chunk.comments}
        onAdd={onAddComment}
        onUpdate={onUpdateComment}
        onDelete={onDeleteComment}
        onPublish={onPublishComment}
      />
    </div>
  );
}

// ── File Box ────────────────────────────────────────────────

function FileBox({
  group,
  onToggleReviewed,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  onPublishComment,
}: {
  group: FileGroup;
  onToggleReviewed: (chunkId: number) => void;
  onAddComment: (chunkId: number, body: string) => Promise<void>;
  onUpdateComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onPublishComment: (commentId: number) => Promise<void>;
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
          onAddComment={(body) => onAddComment(chunk.id, body)}
          onUpdateComment={onUpdateComment}
          onDeleteComment={onDeleteComment}
          onPublishComment={onPublishComment}
          isLast={i === group.chunks.length - 1}
        />
      ))}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────

export function DiffViewer({
  chunks,
  onToggleReviewed,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  onPublishComment,
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
              onUpdateComment={onUpdateComment}
              onDeleteComment={onDeleteComment}
              onPublishComment={onPublishComment}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
