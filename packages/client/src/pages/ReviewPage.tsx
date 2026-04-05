/**
 * Review page – the main PR review interface.
 * Shows file diffs with tag-based grouping sidebar and chunk review controls.
 */

import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import * as api from '@/api';
import { DiffViewer } from '@/components/DiffViewer';
import { useAsync } from '@/hooks/use-async';
import type { ChunkWithDetails, PrWithProgress, Tag } from '@pr-review/shared';

// ── Types ───────────────────────────────────────────────────

interface GroupInfo {
  tag: Tag;
  chunks: ChunkWithDetails[];
  reviewedCount: number;
}

// ── Error Banner ────────────────────────────────────────────

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between border-b border-red-800 bg-red-950 px-4 py-2 text-xs text-red-300">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} className="ml-4 text-red-400 hover:text-white">
        Dismiss
      </button>
    </div>
  );
}

// ── Sidebar ─────────────────────────────────────────────────

function Sidebar({
  pr,
  groups,
  files,
  activeFilter,
  onFilterByTag,
  onFilterByFile,
  onClearFilter,
  onBulkApprove,
}: {
  pr: PrWithProgress;
  groups: GroupInfo[];
  files: string[];
  activeFilter: { type: 'tag' | 'file'; value: string } | null;
  onFilterByTag: (tagName: string) => void;
  onFilterByFile: (filePath: string) => void;
  onClearFilter: () => void;
  onBulkApprove: (tagId: number) => void;
}): React.ReactElement {
  const [filesExpanded, setFilesExpanded] = useState(true);

  return (
    <aside className="flex w-64 flex-shrink-0 flex-col overflow-y-auto border-r border-gray-800 bg-gray-900">
      {/* PR info */}
      <div className="border-b border-gray-800 p-4">
        <Link to="/" className="text-xs text-gray-500 hover:text-gray-300">
          &larr; Back
        </Link>
        <h2 className="mt-2 truncate text-sm font-semibold text-gray-100">{pr.title}</h2>
        <p className="mt-1 text-xs text-gray-500">
          {pr.owner}/{pr.repo}#{pr.number}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-700">
            <div
              className="h-full rounded-full bg-green-500"
              style={{
                width: `${pr.totalChunks === 0 ? 0 : Math.round((pr.reviewedChunks / pr.totalChunks) * 100)}%`,
              }}
            />
          </div>
          <span className="text-xs text-gray-400">
            {pr.reviewedChunks}/{pr.totalChunks}
          </span>
        </div>
      </div>

      {/* Groups section */}
      <div className="border-b border-gray-800 p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Groups
        </h3>
        {activeFilter && (
          <button
            type="button"
            onClick={onClearFilter}
            className="mb-2 w-full rounded bg-gray-800 px-2 py-1 text-left text-xs text-gray-400 hover:text-white"
          >
            Clear filter &times;
          </button>
        )}
        <div className="space-y-1">
          {groups.map((g) => (
            <div
              key={g.tag.name}
              className={`group flex items-center justify-between rounded px-2 py-1.5 text-xs cursor-pointer hover:bg-gray-800 ${
                activeFilter?.type === 'tag' && activeFilter.value === g.tag.name
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-300'
              }`}
              onClick={() => onFilterByTag(g.tag.name)}
              onKeyDown={(e) => e.key === 'Enter' && onFilterByTag(g.tag.name)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: g.tag.color || '#6b7280' }}
                />
                <span className="truncate">{g.tag.name}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500">
                  {g.reviewedCount}/{g.chunks.length}
                </span>
                {g.reviewedCount < g.chunks.length && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onBulkApprove(g.tag.id);
                    }}
                    className="hidden rounded bg-green-800 px-1.5 py-0.5 text-[10px] text-green-200 hover:bg-green-700 group-hover:block"
                    title="Approve all"
                  >
                    Approve
                  </button>
                )}
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <p className="text-xs text-gray-600">No tags assigned yet. Run LLM analysis.</p>
          )}
        </div>
      </div>

      {/* Files section */}
      <div className="flex-1 overflow-y-auto p-4">
        <button
          type="button"
          onClick={() => setFilesExpanded(!filesExpanded)}
          className="mb-2 flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-gray-500"
        >
          <span>Files ({files.length})</span>
          <span>{filesExpanded ? '▾' : '▸'}</span>
        </button>
        {filesExpanded && (
          <div className="space-y-0.5">
            {files.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onFilterByFile(f)}
                className={`block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-gray-800 ${
                  activeFilter?.type === 'file' && activeFilter.value === f
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400'
                }`}
                title={f}
              >
                {f.split('/').pop()}
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

// ── Toolbar ─────────────────────────────────────────────────

function Toolbar({
  hideReviewed,
  onToggleHideReviewed,
  onSync,
  onAnalyze,
  onPublishAll,
  syncing,
  analyzing,
  unpublishedCount,
}: {
  hideReviewed: boolean;
  onToggleHideReviewed: () => void;
  onSync: () => void;
  onAnalyze: () => void;
  onPublishAll: () => Promise<void>;
  syncing: boolean;
  analyzing: boolean;
  unpublishedCount: number;
}): React.ReactElement {
  const [publishing, setPublishing] = useState(false);

  async function handlePublish(): Promise<void> {
    setPublishing(true);
    try {
      await onPublishAll();
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="flex items-center justify-between border-b border-gray-800 bg-gray-900 px-4 py-2">
      <label className="flex items-center gap-2 text-xs text-gray-400">
        <input
          type="checkbox"
          checked={hideReviewed}
          onChange={onToggleHideReviewed}
          className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500"
        />
        Hide reviewed
      </label>
      <div className="flex items-center gap-2">
        {unpublishedCount > 0 && (
          <button
            type="button"
            onClick={handlePublish}
            disabled={publishing}
            className="rounded-md bg-green-700 px-3 py-1 text-xs text-white hover:bg-green-600 disabled:opacity-50"
          >
            {publishing
              ? 'Publishing...'
              : `Publish ${unpublishedCount} comment${unpublishedCount !== 1 ? 's' : ''}`}
          </button>
        )}
        <button
          type="button"
          onClick={onSync}
          disabled={syncing}
          className="rounded-md border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-50"
        >
          {syncing ? 'Syncing...' : 'Sync'}
        </button>
        <button
          type="button"
          onClick={onAnalyze}
          disabled={analyzing}
          className="rounded-md bg-purple-700 px-3 py-1 text-xs text-white hover:bg-purple-600 disabled:opacity-50"
        >
          {analyzing ? 'Analyzing...' : 'Analyze with LLM'}
        </button>
      </div>
    </div>
  );
}

// ── Review Page ─────────────────────────────────────────────

export function ReviewPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const prId = Number(id);

  const [activeFilter, setActiveFilter] = useState<{
    type: 'tag' | 'file';
    value: string;
  } | null>(null);
  const [hideReviewed, setHideReviewed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    data: pr,
    loading: prLoading,
    error: prError,
    reload: reloadPr,
  } = useAsync(() => api.getPr(prId), [prId]);

  const {
    data: chunks,
    loading: chunksLoading,
    error: chunksError,
    reload: reloadChunks,
  } = useAsync(() => api.getChunks(prId), [prId]);

  const { data: tags } = useAsync(() => api.getTags(), []);

  const reload = useCallback(() => {
    reloadPr();
    reloadChunks();
  }, [reloadPr, reloadChunks]);

  /** Wraps an async action with error handling. */
  async function withErrorHandling(fn: () => Promise<void>): Promise<void> {
    setActionError(null);
    try {
      await fn();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  // Build groups from tag assignments
  const groups = useMemo((): GroupInfo[] => {
    if (!chunks || !tags) return [];
    const map = new Map<number, GroupInfo>();
    for (const tag of tags) {
      const tagChunks = chunks.filter((c) => c.tags.some((t) => t.id === tag.id));
      if (tagChunks.length > 0) {
        map.set(tag.id, {
          tag,
          chunks: tagChunks,
          reviewedCount: tagChunks.filter((c) => c.reviewed).length,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.chunks.length - a.chunks.length);
  }, [chunks, tags]);

  // Get unique file list
  const files = useMemo((): string[] => {
    if (!chunks) return [];
    const seen = new Set<string>();
    for (const c of chunks) seen.add(c.filePath);
    return Array.from(seen).sort();
  }, [chunks]);

  // Filter chunks based on active filter and hide-reviewed toggle
  const filteredChunks = useMemo((): ChunkWithDetails[] => {
    if (!chunks) return [];
    let result = chunks;
    if (activeFilter) {
      if (activeFilter.type === 'tag') {
        result = result.filter((c) => c.tags.some((t) => t.name === activeFilter.value));
      } else {
        result = result.filter((c) => c.filePath === activeFilter.value);
      }
    }
    if (hideReviewed) {
      result = result.filter((c) => !c.reviewed);
    }
    return result;
  }, [chunks, activeFilter, hideReviewed]);

  async function handleSync(): Promise<void> {
    setSyncing(true);
    await withErrorHandling(async () => {
      await api.syncPr(prId);
      reload();
    });
    setSyncing(false);
  }

  async function handleAnalyze(): Promise<void> {
    setAnalyzing(true);
    await withErrorHandling(async () => {
      await api.analyzePr(prId);
      reload();
    });
    setAnalyzing(false);
  }

  async function handleToggleReviewed(chunkId: number): Promise<void> {
    await withErrorHandling(async () => {
      await api.toggleReviewed(chunkId);
      reload();
    });
  }

  async function handleBulkApprove(tagId: number): Promise<void> {
    await withErrorHandling(async () => {
      await api.bulkApprove(prId, tagId);
      reload();
    });
  }

  async function handleAddComment(chunkId: number, body: string): Promise<void> {
    await withErrorHandling(async () => {
      await api.createComment({ chunkId, prId, body });
      reloadChunks();
    });
  }

  async function handleUpdateComment(commentId: number, body: string): Promise<void> {
    await withErrorHandling(async () => {
      await api.updateComment(commentId, body);
      reloadChunks();
    });
  }

  async function handleDeleteComment(commentId: number): Promise<void> {
    await withErrorHandling(async () => {
      await api.deleteComment(commentId);
      reloadChunks();
    });
  }

  async function handlePublishComment(commentId: number): Promise<void> {
    if (!pr) return;
    await withErrorHandling(async () => {
      await api.publishComment(commentId, {
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.number,
        ghHost: pr.ghHost !== 'github.com' ? pr.ghHost : undefined,
        commitSha: pr.headSha,
      });
      reloadChunks();
    });
  }

  async function handlePublishAll(): Promise<void> {
    if (!pr) return;
    await withErrorHandling(async () => {
      await api.publishAllComments(prId, {
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.number,
        ghHost: pr.ghHost !== 'github.com' ? pr.ghHost : undefined,
        commitSha: pr.headSha,
      });
      reloadChunks();
    });
  }

  // Count actual unpublished comments (not chunks with unpublished comments)
  const unpublishedCount = useMemo(() => {
    if (!chunks) return 0;
    return chunks.reduce((acc, c) => acc + c.comments.filter((cm) => !cm.publishedAt).length, 0);
  }, [chunks]);

  const loading = prLoading || chunksLoading;
  const error = prError || chunksError;

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-gray-500">Loading...</div>
    );
  }

  if (error || !pr) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2">
        <p className="text-red-400">{error ?? 'PR not found'}</p>
        <Link to="/" className="text-sm text-blue-400 hover:underline">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-49px)]">
      <Sidebar
        pr={pr}
        groups={groups}
        files={files}
        activeFilter={activeFilter}
        onFilterByTag={(name) =>
          setActiveFilter((f) =>
            f?.type === 'tag' && f.value === name ? null : { type: 'tag', value: name },
          )
        }
        onFilterByFile={(path) =>
          setActiveFilter((f) =>
            f?.type === 'file' && f.value === path ? null : { type: 'file', value: path },
          )
        }
        onClearFilter={() => setActiveFilter(null)}
        onBulkApprove={handleBulkApprove}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        {actionError && (
          <ErrorBanner message={actionError} onDismiss={() => setActionError(null)} />
        )}

        <Toolbar
          hideReviewed={hideReviewed}
          onToggleHideReviewed={() => setHideReviewed((h) => !h)}
          onSync={handleSync}
          onAnalyze={handleAnalyze}
          onPublishAll={handlePublishAll}
          syncing={syncing}
          analyzing={analyzing}
          unpublishedCount={unpublishedCount}
        />

        <div className="flex-1 overflow-y-auto">
          {filteredChunks.length === 0 ? (
            <div className="py-12 text-center text-gray-500">
              {hideReviewed
                ? 'All chunks reviewed! Uncheck "Hide reviewed" to see them.'
                : 'No chunks match the current filter.'}
            </div>
          ) : (
            <DiffViewer
              chunks={filteredChunks}
              onToggleReviewed={handleToggleReviewed}
              onAddComment={handleAddComment}
              onUpdateComment={handleUpdateComment}
              onDeleteComment={handleDeleteComment}
              onPublishComment={handlePublishComment}
            />
          )}
        </div>
      </div>
    </div>
  );
}
