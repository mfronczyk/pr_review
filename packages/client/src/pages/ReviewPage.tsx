/**
 * Review page – the main PR review interface.
 * Shows file diffs with tag-based grouping sidebar and chunk review controls.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import * as api from '@/api';
import { DiffViewer } from '@/components/DiffViewer';
import { Markdown } from '@/components/Markdown';
import { SubmitReviewDialog } from '@/components/SubmitReviewDialog';
import { useAsync } from '@/hooks/use-async';
import { getTagColor } from '@/tag-colors';
import type { ChunkWithDetails, PrWithProgress, ReviewEvent, Tag } from '@pr-review/shared';

// ── Types ───────────────────────────────────────────────────

interface GroupInfo {
  tag: Tag;
  chunks: ChunkWithDetails[];
  approvedCount: number;
  summary?: string;
}

// ── Helpers ─────────────────────────────────────────────────

/** Returns true if the chunk has at least one unresolved comment thread. */
function hasUnresolvedComments(chunk: ChunkWithDetails): boolean {
  return chunk.comments.some((c) => c.parentId === null && !c.resolved);
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
  approved,
  color,
}: {
  total: number;
  approved: number;
  color: string;
}): React.ReactElement {
  // For large groups, show a compact bar instead of individual dots
  if (total > 20) {
    const pct = total === 0 ? 0 : Math.round((approved / total) * 100);
    return (
      <div className="flex items-center gap-1.5">
        <div className="h-1 w-10 overflow-hidden rounded-full bg-surface-tertiary">
          <div
            className="h-full rounded-full"
            style={{ width: `${pct}%`, backgroundColor: '#22c55e' }}
          />
        </div>
        <span className="text-[10px] text-fg-muted">
          {approved}/{total}
        </span>
      </div>
    );
  }

  // Build stable keys: approved dots first, then unapproved
  const dots = useMemo(() => {
    const result: Array<{ key: string; filled: boolean }> = [];
    for (let i = 0; i < approved; i++) {
      result.push({ key: `r${i}`, filled: true });
    }
    for (let i = 0; i < total - approved; i++) {
      result.push({ key: `u${i}`, filled: false });
    }
    return result;
  }, [total, approved]);

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

/**
 * Sort tree nodes: directories before files, alphabetical within each group.
 * A collapsed node like "components/Foo.tsx" (isFile but name contains "/")
 * is treated as a directory for sorting purposes.
 */
function sortTreeNodes(a: TreeNode, b: TreeNode): number {
  const aIsDir = !a.isFile || a.name.includes('/');
  const bIsDir = !b.isFile || b.name.includes('/');
  if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function FileTreeNode({
  node,
  depth,
  activeFile,
  onScrollToFile,
  collapsedDirs,
  onToggleDir,
}: {
  node: TreeNode;
  depth: number;
  activeFile: string | null;
  onScrollToFile: (filePath: string) => void;
  collapsedDirs: Set<string>;
  onToggleDir: (dirPath: string) => void;
}): React.ReactElement {
  const isActive = activeFile === node.fullPath;
  const isCollapsed = collapsedDirs.has(node.fullPath);

  if (node.isFile) {
    return (
      <button
        type="button"
        onClick={() => onScrollToFile(node.fullPath)}
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

  const sortedChildren = Array.from(node.children.values()).sort(sortTreeNodes);

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
            activeFile={activeFile}
            onScrollToFile={onScrollToFile}
            collapsedDirs={collapsedDirs}
            onToggleDir={onToggleDir}
          />
        ))}
    </div>
  );
}

// ── Sidebar ─────────────────────────────────────────────────

const Sidebar = memo(function Sidebar({
  pr,
  groups,
  files,
  activeFilter,
  activeFile,
  onFilterByTag,
  onScrollToFile,
  onClearFilter,
  onBulkApprove,
}: {
  pr: PrWithProgress;
  groups: GroupInfo[];
  files: string[];
  activeFilter: { type: 'tag'; value: string } | null;
  activeFile: string | null;
  onFilterByTag: (tagName: string) => void;
  onScrollToFile: (filePath: string) => void;
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
    () => Array.from(fileTree.children.values()).sort(sortTreeNodes),
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
                width: `${pr.totalChunks === 0 ? 0 : Math.round((pr.approvedChunks / pr.totalChunks) * 100)}%`,
              }}
            />
          </div>
          <span className="text-xs text-fg-tertiary">
            {pr.approvedChunks}/{pr.totalChunks}
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
          {groups.map((g) => {
            const allApproved = g.approvedCount >= g.chunks.length;
            const isActive = activeFilter?.type === 'tag' && activeFilter.value === g.tag.name;
            return (
              <div
                key={g.tag.name}
                className={`group rounded px-2 py-1.5 text-xs cursor-pointer hover:bg-surface-active ${
                  allApproved
                    ? 'bg-green-50 dark:bg-green-900/20'
                    : isActive
                      ? 'bg-surface-active text-fg-primary'
                      : 'text-fg-secondary'
                } ${isActive ? 'ring-1 ring-border-primary' : ''}`}
                onClick={() => onFilterByTag(g.tag.name)}
                onKeyDown={(e) => e.key === 'Enter' && onFilterByTag(g.tag.name)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: getTagColor(g.tag.name) }}
                    />
                    <span className={`truncate ${allApproved ? 'text-fg-muted' : ''}`}>
                      {g.tag.name}
                    </span>
                  </div>
                  {allApproved ? (
                    <span className="flex-shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-800/50 dark:text-green-300">
                      ✓ Done
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onBulkApprove(g.tag.id);
                      }}
                      className="flex-shrink-0 rounded bg-green-700 px-1.5 py-0.5 text-[10px] text-white opacity-0 hover:bg-green-600 group-hover:opacity-100 dark:bg-green-800 dark:text-green-200 dark:hover:bg-green-700"
                      title="Approve all"
                    >
                      Approve
                    </button>
                  )}
                </div>
                <div className="mt-1 pl-4">
                  <ProgressDots
                    total={g.chunks.length}
                    approved={g.approvedCount}
                    color={getTagColor(g.tag.name)}
                  />
                </div>
              </div>
            );
          })}
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
                activeFile={activeFile}
                onScrollToFile={onScrollToFile}
                collapsedDirs={collapsedDirs}
                onToggleDir={handleToggleDir}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
});

// ── Toolbar ─────────────────────────────────────────────────

function Toolbar({
  hideApproved,
  onToggleHideApproved,
  showUnresolved,
  onToggleShowUnresolved,
  onSync,
  onAnalyze,
  onPublishAll,
  onSubmitReview,
  syncing,
  analyzing,
  unpublishedCount,
  modelLabel,
  additions,
  deletions,
}: {
  hideApproved: boolean;
  onToggleHideApproved: () => void;
  showUnresolved: boolean;
  onToggleShowUnresolved: () => void;
  onSync: () => void;
  onAnalyze: () => void;
  onPublishAll: () => Promise<void>;
  onSubmitReview: () => void;
  syncing: boolean;
  analyzing: boolean;
  unpublishedCount: number;
  modelLabel: string | null;
  additions: number;
  deletions: number;
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
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-fg-tertiary">
          <input
            type="checkbox"
            checked={hideApproved}
            onChange={onToggleHideApproved}
            className="rounded border-border-primary bg-surface-input text-blue-500 focus:ring-blue-500"
          />
          Hide approved
        </label>
        <label className="flex items-center gap-2 text-xs text-fg-tertiary">
          <input
            type="checkbox"
            checked={showUnresolved}
            onChange={onToggleShowUnresolved}
            className="rounded border-border-primary bg-surface-input text-blue-500 focus:ring-blue-500"
          />
          Show unresolved
        </label>
        <span className="text-xs font-mono">
          <span className="text-green-600 dark:text-green-400">+{additions}</span>{' '}
          <span className="text-red-600 dark:text-red-400">-{deletions}</span>
        </span>
      </div>
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
          onClick={onSubmitReview}
          className="rounded-md bg-green-700 px-3 py-1 text-xs text-white hover:bg-green-600 disabled:opacity-50"
        >
          Submit Review
        </button>
        <button
          type="button"
          onClick={onSync}
          disabled={syncing}
          className="rounded-md border border-border-primary bg-surface-secondary px-3 py-1 text-xs text-fg-secondary hover:bg-surface-tertiary disabled:opacity-50"
        >
          {syncing ? 'Fetching...' : 'Fetch Latest'}
        </button>
        <button
          type="button"
          onClick={onAnalyze}
          disabled={analyzing}
          className="rounded-md bg-purple-600 px-3 py-1 text-xs text-white hover:bg-purple-500 disabled:opacity-50 dark:bg-purple-700 dark:hover:bg-purple-600"
        >
          {analyzing ? 'Analyzing...' : `Analyze with LLM${modelLabel ? ` (${modelLabel})` : ''}`}
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
    type: 'tag';
    value: string;
  } | null>(null);
  const [scrollToFile, setScrollToFile] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [hideApproved, setHideApproved] = useState(false);
  const [showUnresolved, setShowUnresolved] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [departingChunkIds, setDepartingChunkIds] = useState<Set<number>>(new Set());

  const {
    data: pr,
    loading: prLoading,
    error: prError,
    reload: reloadPr,
  } = useAsync(() => api.getPr(prId), [prId]);

  const {
    data: fetchedChunks,
    loading: chunksLoading,
    error: chunksError,
    reload: reloadChunks,
  } = useAsync(() => api.getChunks(prId), [prId]);

  // Local chunks state — updated optimistically without refetching
  const [chunks, setChunks] = useState<ChunkWithDetails[] | null>(null);

  // Sync local state when fresh data arrives from API
  useEffect(() => {
    if (fetchedChunks) {
      setChunks(fetchedChunks);
    }
  }, [fetchedChunks]);

  const { data: tags, reload: reloadTags } = useAsync(() => api.getTags(prId), [prId]);

  const { data: tagSummaries, reload: reloadTagSummaries } = useAsync(
    () => api.getTagSummaries(prId),
    [prId],
  );

  const { data: modelInfo } = useAsync(() => api.getModelInfo(), []);

  const modelLabel = useMemo((): string | null => {
    if (!modelInfo) return null;
    return `${modelInfo.provider}/${modelInfo.model}`;
  }, [modelInfo]);

  const reload = useCallback(() => {
    reloadPr();
    reloadChunks();
    reloadTags();
    reloadTagSummaries();
  }, [reloadPr, reloadChunks, reloadTags, reloadTagSummaries]);

  /** Wraps an async action with error handling. */
  const withErrorHandling = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    setActionError(null);
    try {
      await fn();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Build groups from tag assignments
  const groups = useMemo((): GroupInfo[] => {
    if (!chunks || !tags) return [];
    // Build a lookup from tag name to summary
    const summaryByTagName = new Map<string, string>();
    if (tagSummaries) {
      for (const ts of tagSummaries) {
        summaryByTagName.set(ts.tagName, ts.summary);
      }
    }
    const map = new Map<number, GroupInfo>();
    for (const tag of tags) {
      const tagChunks = chunks.filter((c) => c.tags.some((t) => t.id === tag.id));
      if (tagChunks.length > 0) {
        map.set(tag.id, {
          tag,
          chunks: tagChunks,
          approvedCount: tagChunks.filter((c) => c.approved).length,
          summary: summaryByTagName.get(tag.name),
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.chunks.length - a.chunks.length);
  }, [chunks, tags, tagSummaries]);

  // Derive the active group to show in the main view header:
  // When a tag group is selected, expose it for the tag name + summary display
  const activeGroup = useMemo((): GroupInfo | null => {
    if (activeFilter) {
      return groups.find((g) => g.tag.name === activeFilter.value) ?? null;
    }
    return null;
  }, [activeFilter, groups]);

  // Get unique file list — scoped to the active tag filter so the sidebar
  // only shows files that contain chunks from the selected group.
  const files = useMemo((): string[] => {
    if (!chunks) return [];
    let source = chunks;
    if (activeFilter) {
      source = chunks.filter((c) => c.tags.some((t) => t.name === activeFilter.value));
    }
    const seen = new Set<string>();
    for (const c of source) seen.add(c.filePath);
    return Array.from(seen).sort();
  }, [chunks, activeFilter]);

  // Derive PR progress from local chunks state — avoids refetching PR on every toggle
  const prWithLocalProgress = useMemo((): PrWithProgress | null => {
    if (!pr) return null;
    if (!chunks) return pr;
    const totalChunks = chunks.length;
    const approvedChunks = chunks.filter((c) => c.approved).length;
    // Return same reference if counts haven't changed
    if (pr.totalChunks === totalChunks && pr.approvedChunks === approvedChunks) {
      return pr;
    }
    return { ...pr, totalChunks, approvedChunks };
  }, [pr, chunks]);

  // Filter chunks based on active tag filter and hide-approved toggle
  const filteredChunks = useMemo((): ChunkWithDetails[] => {
    if (!chunks) return [];
    let result = chunks;
    if (activeFilter) {
      result = result.filter((c) => c.tags.some((t) => t.name === activeFilter.value));
    }
    if (hideApproved) {
      result = result.filter(
        (c) =>
          !c.approved ||
          departingChunkIds.has(c.id) ||
          (showUnresolved && hasUnresolvedComments(c)),
      );
    }
    return result;
  }, [chunks, activeFilter, hideApproved, showUnresolved, departingChunkIds]);

  /** Called after a chunk's exit animation completes — remove it from the departing set. */
  const handleChunkDeparted = useCallback((chunkId: number): void => {
    setDepartingChunkIds((prev) => {
      const next = new Set(prev);
      next.delete(chunkId);
      return next;
    });
  }, []);

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

  const handleToggleApproved = useCallback(
    async (chunkId: number): Promise<void> => {
      // Check if this chunk is currently unapproved (will become approved)
      const isApproving = chunks?.find((c) => c.id === chunkId)?.approved === false;

      // Optimistically toggle the approved state locally
      setChunks((prev) => {
        if (!prev) return prev;
        return prev.map((c) => (c.id === chunkId ? { ...c, approved: !c.approved } : c));
      });

      // If approving with hideApproved on, animate the chunk out
      // (unless showUnresolved is on and the chunk has unresolved comments)
      if (isApproving && hideApproved) {
        const chunk = chunks?.find((c) => c.id === chunkId);
        if (!showUnresolved || !chunk || !hasUnresolvedComments(chunk)) {
          setDepartingChunkIds((prev) => new Set(prev).add(chunkId));
        }
      }

      await withErrorHandling(async () => {
        await api.toggleApproved(chunkId);
        // No reloadPr() — progress is derived from local chunks state
      });
    },
    [chunks, hideApproved, showUnresolved, withErrorHandling],
  );

  const handleBulkApprove = useCallback(
    async (tagId: number): Promise<void> => {
      // Optimistically mark all chunks with this tag as approved
      setChunks((prev) => {
        if (!prev) return prev;
        return prev.map((c) => (c.tags.some((t) => t.id === tagId) ? { ...c, approved: true } : c));
      });
      await withErrorHandling(async () => {
        await api.bulkApprove(prId, tagId);
        // No reloadPr() — progress is derived from local chunks state
      });
    },
    [prId, withErrorHandling],
  );

  const handleAddComment = useCallback(
    async (chunkId: number, body: string, line: number, side: 'LEFT' | 'RIGHT'): Promise<void> => {
      await withErrorHandling(async () => {
        const comment = await api.createComment({ chunkId, prId, body, line, side });
        // Optimistically add the comment to local state
        setChunks((prev) => {
          if (!prev) return prev;
          return prev.map((c) =>
            c.id === chunkId ? { ...c, comments: [...c.comments, comment] } : c,
          );
        });
      });
    },
    [prId, withErrorHandling],
  );

  const handleReplyComment = useCallback(
    async (chunkId: number, parentId: number, body: string): Promise<void> => {
      await withErrorHandling(async () => {
        // Find the parent to get line number and side
        const parentComment = chunks?.flatMap((c) => c.comments).find((cm) => cm.id === parentId);
        const line = parentComment?.line ?? 0;
        const side = parentComment?.side ?? 'RIGHT';
        const comment = await api.createComment({ chunkId, prId, body, line, side, parentId });
        setChunks((prev) => {
          if (!prev) return prev;
          return prev.map((c) =>
            c.id === chunkId ? { ...c, comments: [...c.comments, comment] } : c,
          );
        });
      });
    },
    [prId, chunks, withErrorHandling],
  );

  const handleUpdateComment = useCallback(
    async (commentId: number, body: string): Promise<void> => {
      await withErrorHandling(async () => {
        const updated = await api.updateComment(commentId, body);
        setChunks((prev) => {
          if (!prev) return prev;
          return prev.map((c) => ({
            ...c,
            comments: c.comments.map((cm) => (cm.id === commentId ? updated : cm)),
          }));
        });
      });
    },
    [withErrorHandling],
  );

  const handleDeleteComment = useCallback(
    async (commentId: number): Promise<void> => {
      await withErrorHandling(async () => {
        await api.deleteComment(commentId);
        setChunks((prev) => {
          if (!prev) return prev;
          return prev.map((c) => ({
            ...c,
            comments: c.comments.filter((cm) => cm.id !== commentId),
          }));
        });
      });
    },
    [withErrorHandling],
  );

  const handlePublishComment = useCallback(
    async (commentId: number): Promise<void> => {
      if (!pr) return;
      await withErrorHandling(async () => {
        const published = await api.publishComment(commentId, {
          owner: pr.owner,
          repo: pr.repo,
          prNumber: pr.number,
          ghHost: pr.ghHost !== 'github.com' ? pr.ghHost : undefined,
          commitSha: pr.headSha,
        });
        setChunks((prev) => {
          if (!prev) return prev;
          return prev.map((c) => ({
            ...c,
            comments: c.comments.map((cm) => (cm.id === commentId ? published : cm)),
          }));
        });
      });
    },
    [pr, withErrorHandling],
  );

  const handleResolveThread = useCallback(
    async (commentId: number): Promise<void> => {
      await withErrorHandling(async () => {
        const resolved = await api.resolveThread(commentId);
        setChunks((prev) => {
          if (!prev) return prev;
          return prev.map((c) => ({
            ...c,
            comments: c.comments.map((cm) => (cm.id === commentId ? resolved : cm)),
          }));
        });

        // If resolving this thread will cause an approved chunk to be hidden
        // (no remaining unresolved threads), trigger the departure animation
        // so it fades out instead of vanishing and causing a scroll-to-top.
        if (hideApproved) {
          const chunk = chunks?.find((c) => c.comments.some((cm) => cm.id === commentId));
          if (chunk?.approved) {
            const remainingUnresolved = chunk.comments.filter(
              (cm) => cm.parentId === null && !cm.resolved && cm.id !== commentId,
            );
            if (remainingUnresolved.length === 0) {
              setDepartingChunkIds((prev) => new Set(prev).add(chunk.id));
            }
          }
        }
      });
    },
    [chunks, hideApproved, withErrorHandling],
  );

  const handleUnresolveThread = useCallback(
    async (commentId: number): Promise<void> => {
      await withErrorHandling(async () => {
        const unresolved = await api.unresolveThread(commentId);
        setChunks((prev) => {
          if (!prev) return prev;
          return prev.map((c) => ({
            ...c,
            comments: c.comments.map((cm) => (cm.id === commentId ? unresolved : cm)),
          }));
        });
      });
    },
    [withErrorHandling],
  );

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

  const handleSubmitReview = useCallback(
    async (event: ReviewEvent, body?: string): Promise<void> => {
      setSubmittingReview(true);
      try {
        await withErrorHandling(async () => {
          await api.submitReview(prId, event, body);
          setReviewDialogOpen(false);
        });
      } finally {
        setSubmittingReview(false);
      }
    },
    [prId, withErrorHandling],
  );

  // Count actual unpublished comments (not chunks with unpublished comments)
  const unpublishedCount = useMemo(() => {
    if (!chunks) return 0;
    return chunks.reduce((acc, c) => acc + c.comments.filter((cm) => !cm.publishedAt).length, 0);
  }, [chunks]);

  // Stable callback refs for Sidebar — avoids re-renders from inline arrow functions
  const handleFilterByTag = useCallback(
    (name: string) =>
      setActiveFilter((f) =>
        f?.type === 'tag' && f.value === name ? null : { type: 'tag', value: name },
      ),
    [],
  );

  const handleScrollToFile = useCallback((path: string) => {
    setActiveFile((prev) => (prev === path ? null : path));
    setScrollToFile(path);
  }, []);

  const handleScrollToFileDone = useCallback(() => {
    setScrollToFile(null);
  }, []);

  const handleClearFilter = useCallback(() => {
    setActiveFilter(null);
    setActiveFile(null);
  }, []);

  const handleDismissError = useCallback(() => setActionError(null), []);

  const handleToggleHideApproved = useCallback(() => {
    setHideApproved((prev) => {
      if (prev) {
        // Toggling off — clear any stale departing state
        setDepartingChunkIds(new Set());
      }
      return !prev;
    });
  }, []);

  const loading = prLoading || chunksLoading;
  const error = prError || chunksError;

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-fg-muted">Loading...</div>
    );
  }

  if (error || !prWithLocalProgress) {
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
        pr={prWithLocalProgress}
        groups={groups}
        files={files}
        activeFilter={activeFilter}
        activeFile={activeFile}
        onFilterByTag={handleFilterByTag}
        onScrollToFile={handleScrollToFile}
        onClearFilter={handleClearFilter}
        onBulkApprove={handleBulkApprove}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        {actionError && <ErrorBanner message={actionError} onDismiss={handleDismissError} />}

        <Toolbar
          hideApproved={hideApproved}
          onToggleHideApproved={handleToggleHideApproved}
          showUnresolved={showUnresolved}
          onToggleShowUnresolved={() => setShowUnresolved((v) => !v)}
          onSync={handleSync}
          onAnalyze={handleAnalyze}
          onPublishAll={handlePublishAll}
          onSubmitReview={() => setReviewDialogOpen(true)}
          syncing={syncing}
          analyzing={analyzing}
          unpublishedCount={unpublishedCount}
          modelLabel={modelLabel}
          additions={prWithLocalProgress.additions}
          deletions={prWithLocalProgress.deletions}
        />

        <div className="flex-1 overflow-hidden">
          {filteredChunks.length === 0 ? (
            <div className="py-12 text-center text-fg-muted">
              {hideApproved
                ? 'All chunks approved! Uncheck "Hide approved" to see them.'
                : 'No chunks match the current filter.'}
            </div>
          ) : (
            <DiffViewer
              chunks={filteredChunks}
              departingChunkIds={departingChunkIds}
              scrollToFile={scrollToFile}
              headerContent={
                activeGroup ? (
                  <div className="mx-auto mb-4 max-w-3xl">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: getTagColor(activeGroup.tag.name) }}
                      />
                      <h2 className="text-sm font-semibold text-fg-primary">
                        {activeGroup.tag.name}
                      </h2>
                    </div>
                    {activeGroup.summary && (
                      <div className="rounded-lg border border-border-secondary bg-surface-secondary px-4 py-2">
                        <Markdown
                          text={activeGroup.summary}
                          className="text-xs text-fg-secondary"
                        />
                      </div>
                    )}
                  </div>
                ) : undefined
              }
              onToggleApproved={handleToggleApproved}
              onChunkDeparted={handleChunkDeparted}
              onScrollToFileDone={handleScrollToFileDone}
              onAddComment={handleAddComment}
              onReplyComment={handleReplyComment}
              onUpdateComment={handleUpdateComment}
              onDeleteComment={handleDeleteComment}
              onPublishComment={handlePublishComment}
              onResolveThread={handleResolveThread}
              onUnresolveThread={handleUnresolveThread}
            />
          )}
        </div>
      </div>

      <SubmitReviewDialog
        isOpen={reviewDialogOpen}
        onClose={() => setReviewDialogOpen(false)}
        onSubmit={handleSubmitReview}
        isSubmitting={submittingReview}
      />
    </div>
  );
}
