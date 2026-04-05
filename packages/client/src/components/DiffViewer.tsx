/**
 * DiffViewer – renders a list of diff chunks as a continuous scroll view.
 * Groups chunks by file and displays unified diff with syntax highlighting.
 */

import { useMemo } from 'react';

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

interface FileGroup {
  filePath: string;
  chunks: ChunkWithDetails[];
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
    high: 'bg-red-900/50 text-red-300 border-red-700',
    medium: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
    low: 'bg-gray-800 text-gray-400 border-gray-700',
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
}: {
  chunk: ChunkWithDetails;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-gray-800 bg-gray-900 px-3 py-1.5">
      <button
        type="button"
        onClick={onToggle}
        className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border text-xs ${
          chunk.reviewed
            ? 'border-green-600 bg-green-600 text-white'
            : 'border-gray-600 bg-transparent text-transparent hover:border-gray-400'
        }`}
        title={chunk.reviewed ? 'Mark unreviewed' : 'Mark reviewed'}
      >
        {chunk.reviewed ? '✓' : ''}
      </button>

      <span className="text-xs text-gray-500">
        L{chunk.startLine}–{chunk.endLine}
      </span>

      {chunk.tags.map((t) => (
        <TagPill key={t.id} name={t.name} color={t.color} />
      ))}

      {chunk.metadata?.priority && <PriorityBadge priority={chunk.metadata.priority} />}

      {chunk.comments.length > 0 && (
        <span className="text-xs text-gray-500">
          {chunk.comments.length} comment{chunk.comments.length !== 1 ? 's' : ''}
        </span>
      )}

      {chunk.reviewed && <span className="ml-auto text-[10px] text-green-600">Reviewed</span>}
    </div>
  );
}

// ── Review Note ─────────────────────────────────────────────

function ReviewNote({ note }: { note: string }): React.ReactElement {
  return (
    <div className="border-b border-gray-800 bg-yellow-950/30 px-3 py-1 text-xs text-yellow-200">
      <span className="mr-1">⚡</span>
      {note}
    </div>
  );
}

// ── Diff Line ───────────────────────────────────────────────

function DiffLine({ line }: { line: string }): React.ReactElement {
  let bgClass = '';
  let textClass = 'text-gray-300';

  if (line.startsWith('+')) {
    bgClass = 'bg-green-950/40';
    textClass = 'text-green-300';
  } else if (line.startsWith('-')) {
    bgClass = 'bg-red-950/40';
    textClass = 'text-red-300';
  } else if (line.startsWith('@@')) {
    bgClass = 'bg-blue-950/30';
    textClass = 'text-blue-400';
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
}: {
  chunk: ChunkWithDetails;
  onToggleReviewed: () => void;
  onAddComment: (body: string) => Promise<void>;
  onUpdateComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onPublishComment: (commentId: number) => Promise<void>;
}): React.ReactElement {
  const lines = chunk.diffText.split('\n');

  // Collapsed view for reviewed chunks when visible
  if (chunk.reviewed) {
    return (
      <div className="border-b border-gray-800 opacity-60">
        <ChunkHeader chunk={chunk} onToggle={onToggleReviewed} />
      </div>
    );
  }

  return (
    <div className="border-b border-gray-800">
      <ChunkHeader chunk={chunk} onToggle={onToggleReviewed} />
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

// ── File Section ────────────────────────────────────────────

function FileSection({
  file,
  onToggleReviewed,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  onPublishComment,
}: {
  file: FileGroup;
  onToggleReviewed: (chunkId: number) => void;
  onAddComment: (chunkId: number, body: string) => Promise<void>;
  onUpdateComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onPublishComment: (commentId: number) => Promise<void>;
}): React.ReactElement {
  const allReviewed = file.chunks.every((c) => c.reviewed);
  return (
    <div className="mb-4">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-gray-700 bg-gray-950 px-4 py-2">
        <span className="font-mono text-xs text-gray-300">{file.filePath}</span>
        <span className="text-xs text-gray-600">
          ({file.chunks.length} chunk{file.chunks.length !== 1 ? 's' : ''})
        </span>
        {allReviewed && <span className="text-xs text-green-600">✓ All reviewed</span>}
      </div>
      {file.chunks.map((chunk) => (
        <ChunkBlock
          key={chunk.id}
          chunk={chunk}
          onToggleReviewed={() => onToggleReviewed(chunk.id)}
          onAddComment={(body) => onAddComment(chunk.id, body)}
          onUpdateComment={onUpdateComment}
          onDeleteComment={onDeleteComment}
          onPublishComment={onPublishComment}
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
    return Array.from(map.entries()).map(([filePath, fileChunks]) => ({
      filePath,
      chunks: fileChunks.sort((a, b) => a.chunkIndex - b.chunkIndex),
    }));
  }, [chunks]);

  return (
    <div className="pb-8">
      {fileGroups.map((file) => (
        <FileSection
          key={file.filePath}
          file={file}
          onToggleReviewed={onToggleReviewed}
          onAddComment={onAddComment}
          onUpdateComment={onUpdateComment}
          onDeleteComment={onDeleteComment}
          onPublishComment={onPublishComment}
        />
      ))}
    </div>
  );
}
