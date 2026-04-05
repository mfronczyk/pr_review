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
    <div className="flex items-center justify-between border-b border-error-border bg-error-bg px-4 py-2 text-xs text-error-fg">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} className="ml-4 text-red-500 hover:text-fg-primary">
        Dismiss
      </button>
    </div>
  );
}

// ── Progress Dots ───────────────────────────────────────────

function ProgressDots({
  total,
  reviewed,
  color,
}: {
  total: number;
  reviewed: number;
  color: string;
}): React.ReactElement {
  // For large groups, show a compact bar instead of individual dots
  if (total > 20) {
    const pct = total === 0 ? 0 : Math.round((reviewed / total) * 100);
    return (
      <div className="flex items-center gap-1.5">
        <div className="h-1 w-10 overflow-hidden rounded-full bg-surface-tertiary">
          <div
            className="h-full rounded-full"
            style={{ width: `${pct}%`, backgroundColor: '#22c55e' }}
          />
        </div>
        <span className="text-[10px] text-fg-muted">
          {reviewed}/{total}
        </span>
      </div>
    );
  }

  // Build stable keys: reviewed dots first, then unreviewed
  const dots = useMemo(() => {
    const result: Array<{ key: string; filled: boolean }> = [];
    for (let i = 0; i < reviewed; i++) {
      result.push({ key: `r${i}`, filled: true });
    }
    for (let i = 0; i < total - reviewed; i++) {
      result.push({ key: `u${i}`, filled: false });
    }
    return result;
  }, [total, reviewed]);

  return (
    <div className="flex flex-wrap items-center gap-0.5">
      {dots.map((dot) => (
        <span
          key={dot.key}
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{
            backgroundColor: dot.filled ? '#22c55e' : `${color}44`,
          }}
        />
      ))}
    </div>
  );
}

// ── File Tree ───────────────────────────────────────────────

interface TreeNode {
  name: string;
  fullPath: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

function buildFileTree(files: string[]): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', children: new Map(), isFile: false };
  for (const filePath of files) {
    const parts = filePath.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      let child = current.children.get(part);
      if (!child) {
        child = {
          name: part,
          fullPath: parts.slice(0, i + 1).join('/'),
          children: new Map(),
          isFile: isLast,
        };
        current.children.set(part, child);
      }
      if (isLast) {
        child.isFile = true;
        child.fullPath = filePath;
      }
      current = child;
    }
  }
  return collapseTree(root);
}

/** Collapse single-child directory chains: a/b/c → a/b/c */
function collapseTree(node: TreeNode): TreeNode {
  const collapsed: Map<string, TreeNode> = new Map();
  for (const [, child] of node.children) {
    let current = child;
    // Collapse chains of directories with only one child
    while (!current.isFile && current.children.size === 1) {
      const only = current.children.values().next().value;
      if (!only) break;
      current = {
        name: `${current.name}/${only.name}`,
        fullPath: only.fullPath,
        children: only.children,
        isFile: only.isFile,
      };
    }
    // Recursively collapse children
    const result = collapseTree(current);
    collapsed.set(result.name, result);
  }
  return { ...node, children: collapsed };
}

function FileTreeNode({
  node,
  depth,
  activeFilter,
  onFilterByFile,
  collapsedDirs,
  onToggleDir,
}: {
  node: TreeNode;
  depth: number;
  activeFilter: { type: 'tag' | 'file'; value: string } | null;
  onFilterByFile: (filePath: string) => void;
  collapsedDirs: Set<string>;
  onToggleDir: (dirPath: string) => void;
}): React.ReactElement {
  const isActive = activeFilter?.type === 'file' && activeFilter.value === node.fullPath;
  const isCollapsed = collapsedDirs.has(node.fullPath);

  if (node.isFile) {
    return (
      <button
        type="button"
        onClick={() => onFilterByFile(node.fullPath)}
        className={`flex w-full items-center gap-1 rounded py-0.5 pr-1 text-left text-xs hover:bg-surface-active ${
          isActive ? 'bg-surface-active text-fg-primary' : 'text-fg-secondary'
        }`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        title={node.fullPath}
      >
        <span className="flex-shrink-0 text-fg-faint">~</span>
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  const sortedChildren = Array.from(node.children.values()).sort((a, b) => {
    // Directories first, then files
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleDir(node.fullPath)}
        className="flex w-full items-center gap-1 rounded py-0.5 pr-1 text-left text-xs text-fg-muted hover:bg-surface-active hover:text-fg-secondary"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        <span className="flex-shrink-0 text-[10px]">{isCollapsed ? '▸' : '▾'}</span>
        <span className="truncate">{node.name}/</span>
      </button>
      {!isCollapsed &&
        sortedChildren.map((child) => (
          <FileTreeNode
            key={child.fullPath}
            node={child}
            depth={depth + 1}
            activeFilter={activeFilter}
            onFilterByFile={onFilterByFile}
            collapsedDirs={collapsedDirs}
            onToggleDir={onToggleDir}
          />
        ))}
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
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  const fileTree = useMemo(() => buildFileTree(files), [files]);

  function handleToggleDir(dirPath: string): void {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }

  const sortedRootChildren = useMemo(
    () =>
      Array.from(fileTree.children.values()).sort((a, b) => {
        if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
        return a.name.localeCompare(b.name);
      }),
    [fileTree],
  );

  return (
    <aside className="flex w-64 flex-shrink-0 flex-col border-r border-border-primary bg-surface-primary">
      {/* PR info — fixed */}
      <div className="flex-shrink-0 border-b border-border-secondary p-4">
        <Link to="/" className="text-xs text-fg-muted hover:text-fg-secondary">
          &larr; Back
        </Link>
        <h2 className="mt-2 truncate text-sm font-semibold text-fg-primary">{pr.title}</h2>
        <p className="mt-1 text-xs text-fg-muted">
          {pr.owner}/{pr.repo}#{pr.number}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-tertiary">
            <div
              className="h-full rounded-full bg-green-500"
              style={{
                width: `${pr.totalChunks === 0 ? 0 : Math.round((pr.reviewedChunks / pr.totalChunks) * 100)}%`,
              }}
            />
          </div>
          <span className="text-xs text-fg-tertiary">
            {pr.reviewedChunks}/{pr.totalChunks}
          </span>
        </div>
      </div>

      {/* Groups section — scrollable, max 40% of sidebar */}
      <div
        className="flex-shrink-0 overflow-y-auto border-b border-border-secondary p-4"
        style={{ maxHeight: '40%' }}
      >
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">
          Groups
        </h3>
        {activeFilter && (
          <button
            type="button"
            onClick={onClearFilter}
            className="mb-2 w-full rounded bg-surface-secondary px-2 py-1 text-left text-xs text-fg-tertiary hover:text-fg-primary"
          >
            Clear filter &times;
          </button>
        )}
        <div className="space-y-1.5">
          {groups.map((g) => (
            <div
              key={g.tag.name}
              className={`group rounded px-2 py-1.5 text-xs cursor-pointer hover:bg-surface-active ${
                activeFilter?.type === 'tag' && activeFilter.value === g.tag.name
                  ? 'bg-surface-active text-fg-primary'
                  : 'text-fg-secondary'
              }`}
              onClick={() => onFilterByTag(g.tag.name)}
              onKeyDown={(e) => e.key === 'Enter' && onFilterByTag(g.tag.name)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: g.tag.color || '#6b7280' }}
                  />
                  <span className="truncate">{g.tag.name}</span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onBulkApprove(g.tag.id);
                  }}
                  className={`flex-shrink-0 rounded bg-green-700 px-1.5 py-0.5 text-[10px] text-white hover:bg-green-600 dark:bg-green-800 dark:text-green-200 dark:hover:bg-green-700 ${
                    g.reviewedCount < g.chunks.length
                      ? 'opacity-0 group-hover:opacity-100'
                      : 'invisible'
                  }`}
                  title="Approve all"
                  disabled={g.reviewedCount >= g.chunks.length}
                >
                  Approve
                </button>
              </div>
              <div className="mt-1 pl-4">
                <ProgressDots
                  total={g.chunks.length}
                  reviewed={g.reviewedCount}
                  color={g.tag.color || '#6b7280'}
                />
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <p className="text-xs text-fg-faint">No tags assigned yet. Run LLM analysis.</p>
          )}
        </div>
      </div>

      {/* Files section — takes remaining space, scrollable */}
      <div className="flex-1 overflow-y-auto p-4">
        <button
          type="button"
          onClick={() => setFilesExpanded(!filesExpanded)}
          className="mb-2 flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-fg-muted"
        >
          <span>Files ({files.length})</span>
          <span>{filesExpanded ? '▾' : '▸'}</span>
        </button>
        {filesExpanded && (
          <div className="space-y-0">
            {sortedRootChildren.map((child) => (
              <FileTreeNode
                key={child.fullPath}
                node={child}
                depth={0}
                activeFilter={activeFilter}
                onFilterByFile={onFilterByFile}
                collapsedDirs={collapsedDirs}
                onToggleDir={handleToggleDir}
              />
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
    <div className="flex items-center justify-between border-b border-border-primary bg-surface-primary px-4 py-2">
      <label className="flex items-center gap-2 text-xs text-fg-tertiary">
        <input
          type="checkbox"
          checked={hideReviewed}
          onChange={onToggleHideReviewed}
          className="rounded border-border-primary bg-surface-input text-blue-500 focus:ring-blue-500"
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
          className="rounded-md border border-border-primary bg-surface-secondary px-3 py-1 text-xs text-fg-secondary hover:bg-surface-tertiary disabled:opacity-50"
        >
          {syncing ? 'Syncing...' : 'Sync'}
        </button>
        <button
          type="button"
          onClick={onAnalyze}
          disabled={analyzing}
          className="rounded-md bg-purple-600 px-3 py-1 text-xs text-white hover:bg-purple-500 disabled:opacity-50 dark:bg-purple-700 dark:hover:bg-purple-600"
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
      <div className="flex h-screen items-center justify-center text-fg-muted">Loading...</div>
    );
  }

  if (error || !pr) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2">
        <p className="text-red-500">{error ?? 'PR not found'}</p>
        <Link to="/" className="text-sm text-blue-500 hover:underline">
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

        <div className="flex-1 overflow-hidden">
          {filteredChunks.length === 0 ? (
            <div className="py-12 text-center text-fg-muted">
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
