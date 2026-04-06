/**
 * Dashboard page – lists tracked PRs with progress and provides an Add PR form.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';

import * as api from '@/api';
import { useAsync } from '@/hooks/use-async';
import type { PrWithProgress } from '@pr-review/shared';

// ── Add PR Form ─────────────────────────────────────────────

function AddPrForm({ onAdded }: { onAdded: () => void }): React.ReactElement {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function parseUrl(
    input: string,
  ): { owner: string; repo: string; number: number; ghHost?: string } | null {
    // Support: https://github.com/owner/repo/pull/123
    //          owner/repo#123
    //          owner/repo 123
    const urlMatch = input.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (urlMatch) {
      const host = urlMatch[1] === 'github.com' ? undefined : urlMatch[1];
      return {
        owner: urlMatch[2],
        repo: urlMatch[3],
        number: Number.parseInt(urlMatch[4], 10),
        ghHost: host,
      };
    }

    const shortMatch = input.match(/^([^/\s]+)\/([^#\s]+)[#\s]+(\d+)$/);
    if (shortMatch) {
      return {
        owner: shortMatch[1],
        repo: shortMatch[2],
        number: Number.parseInt(shortMatch[3], 10),
      };
    }

    return null;
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const parsed = parseUrl(url.trim());
    if (!parsed) {
      setError('Invalid format. Use https://github.com/owner/repo/pull/123 or owner/repo#123');
      return;
    }
    setLoading(true);
    try {
      await api.addPr(parsed);
      setUrl('');
      onAdded();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-start gap-3">
      <div className="flex-1">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo/pull/123 or owner/repo#123"
          className="w-full rounded-md border border-border-primary bg-surface-input px-3 py-2 text-sm text-fg-primary placeholder-fg-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          disabled={loading}
        />
        {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      </div>
      <button
        type="submit"
        disabled={loading || !url.trim()}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Adding...' : 'Add PR'}
      </button>
    </form>
  );
}

// ── Progress Bar ────────────────────────────────────────────

function ProgressBar({
  approved,
  total,
}: {
  approved: number;
  total: number;
}): React.ReactElement {
  const pct = total === 0 ? 0 : Math.round((approved / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-surface-tertiary">
        <div
          className="h-full rounded-full bg-green-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-fg-tertiary">
        {approved}/{total} ({pct}%)
      </span>
    </div>
  );
}

// ── State Badge ─────────────────────────────────────────────

function StateBadge({ state }: { state: string }): React.ReactElement {
  const colors: Record<string, string> = {
    open: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
    closed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
    merged: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
    draft: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colors[state] ?? colors.draft}`}
    >
      {state}
    </span>
  );
}

// ── PR Row ──────────────────────────────────────────────────

function PrRow({
  pr,
  onDelete,
}: {
  pr: PrWithProgress;
  onDelete: (id: number) => void;
}): React.ReactElement {
  return (
    <div className="group relative rounded-lg border border-border-secondary bg-surface-primary transition hover:border-border-primary">
      <Link to={`/pr/${pr.id}`} className="block p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-fg-muted">
                {pr.owner}/{pr.repo}#{pr.number}
              </span>
              <StateBadge state={pr.state} />
            </div>
            <h3 className="mt-1 truncate text-sm font-medium text-fg-primary">{pr.title}</h3>
            <p className="mt-1 text-xs text-fg-muted">by {pr.author}</p>
          </div>
          <div className="flex-shrink-0">
            <ProgressBar approved={pr.approvedChunks} total={pr.totalChunks} />
          </div>
        </div>
      </Link>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          onDelete(pr.id);
        }}
        className="absolute right-2 top-2 hidden rounded px-1.5 py-0.5 text-[10px] text-fg-muted hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-900/50 dark:hover:text-red-300 group-hover:block"
        title="Remove PR"
      >
        Remove
      </button>
    </div>
  );
}

// ── Dashboard Page ──────────────────────────────────────────

export function Dashboard(): React.ReactElement {
  const { data: prs, loading, error, reload } = useAsync(() => api.listPrs(), []);
  const { data: config } = useAsync(() => api.getConfig(), []);

  async function handleDelete(id: number): Promise<void> {
    await api.deletePr(id);
    reload();
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6">
        <h1 className="mb-1 text-2xl font-bold">Pull Requests</h1>
        <p className="text-sm text-fg-tertiary">
          Add a PR to start reviewing. Diffs are fetched from your local git repo.
        </p>
        {config && <p className="mt-1 text-xs text-fg-muted font-mono">{config.repoPath}</p>}
      </div>

      <div className="mb-6">
        <AddPrForm onAdded={reload} />
      </div>

      {loading && <div className="py-12 text-center text-fg-muted">Loading...</div>}

      {error && (
        <div className="rounded-md border border-error-border bg-error-bg p-4 text-sm text-error-fg">
          {error}
        </div>
      )}

      {prs && prs.length === 0 && (
        <div className="py-12 text-center text-fg-muted">
          No PRs added yet. Paste a GitHub PR URL above to get started.
        </div>
      )}

      {prs && prs.length > 0 && (
        <div className="space-y-3">
          {prs.map((pr) => (
            <PrRow key={pr.id} pr={pr} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
