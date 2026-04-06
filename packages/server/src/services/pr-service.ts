import type {
  PrState,
  PullRequest,
  ReviewEvent,
  SubmitReviewResponse,
  SyncResult,
} from '@pr-review/shared';
import type Database from 'better-sqlite3';
import { CommentService } from './comment-service.js';
import { flattenChunks, parseDiff } from './diff-parser.js';
import { GitService } from './git.js';
import { getOctokit } from './github-client.js';

export interface PrServiceOptions {
  db: Database.Database;
  repoPath: string;
}

/**
 * Orchestrates PR operations: fetching metadata from GitHub,
 * computing diffs from local git, parsing chunks, and persisting to SQLite.
 */
export class PrService {
  private readonly db: Database.Database;
  private readonly git: GitService;

  constructor(options: PrServiceOptions) {
    this.db = options.db;
    this.git = new GitService({ repoPath: options.repoPath });
  }

  /**
   * Add a new PR to track. Fetches metadata from GitHub, computes diff
   * from local git, parses into chunks, and stores everything.
   */
  async addPr(
    owner: string,
    repo: string,
    prNumber: number,
    ghHost = 'github.com',
  ): Promise<PullRequest> {
    // 1. Fetch PR metadata from GitHub API
    const octokit = await getOctokit(ghHost);
    const { data: ghPr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    // 2. Map GitHub state to our state
    const state = mapGhState(ghPr.state, ghPr.merged, ghPr.draft);

    // 3. Insert PR into database
    const insertPr = this.db.prepare(`
      INSERT INTO prs (owner, repo, number, title, author, state, base_ref, head_ref, head_sha, body, gh_host)
      VALUES (@owner, @repo, @number, @title, @author, @state, @baseRef, @headRef, @headSha, @body, @ghHost)
      ON CONFLICT (owner, repo, number, gh_host) DO UPDATE SET
        title = @title,
        author = @author,
        state = @state,
        base_ref = @baseRef,
        head_ref = @headRef,
        head_sha = @headSha,
        body = @body,
        updated_at = datetime('now')
    `);

    const prRow = {
      owner,
      repo,
      number: prNumber,
      title: ghPr.title,
      author: ghPr.user?.login ?? 'unknown',
      state,
      baseRef: ghPr.base.ref,
      headRef: ghPr.head.ref,
      headSha: ghPr.head.sha,
      body: ghPr.body ?? '',
      ghHost: ghHost,
    };

    insertPr.run(prRow);

    const pr = this.db
      .prepare('SELECT * FROM prs WHERE owner = ? AND repo = ? AND number = ? AND gh_host = ?')
      .get(owner, repo, prNumber, ghHost) as PrDbRow;

    // 4. Fetch PR branch and compute diff
    await this.fetchAndStoreDiff(pr);

    return mapPrRow(pr);
  }

  /**
   * Sync a PR: re-fetch metadata, recompute diff, and update chunks.
   * Returns what changed since last sync.
   */
  async syncPr(prId: number): Promise<SyncResult> {
    const pr = this.db.prepare('SELECT * FROM prs WHERE id = ?').get(prId) as PrDbRow | undefined;
    if (!pr) {
      throw new Error(`PR not found: ${prId}`);
    }

    // Re-fetch metadata
    const octokit = await getOctokit(pr.gh_host);
    const { data: ghPr } = await octokit.pulls.get({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
    });

    const state = mapGhState(ghPr.state, ghPr.merged, ghPr.draft);

    this.db
      .prepare(
        `UPDATE prs SET title = ?, author = ?, state = ?, base_ref = ?, head_ref = ?,
       head_sha = ?, body = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(
        ghPr.title,
        ghPr.user?.login ?? 'unknown',
        state,
        ghPr.base.ref,
        ghPr.head.ref,
        ghPr.head.sha,
        ghPr.body ?? '',
        prId,
      );

    // Recompute diff and update chunks
    const updatedPr = this.db.prepare('SELECT * FROM prs WHERE id = ?').get(prId) as PrDbRow;
    const result = await this.fetchAndStoreDiff(updatedPr);

    // Import GitHub comments (new replies, etc.)
    const commentService = new CommentService({ db: this.db });
    await commentService.importGitHubComments(
      prId,
      updatedPr.owner,
      updatedPr.repo,
      updatedPr.number,
      updatedPr.gh_host,
    );

    return result;
  }

  /**
   * Fetch the PR branch via git, compute diff, parse into chunks,
   * and reconcile with the database.
   */
  private async fetchAndStoreDiff(pr: PrDbRow): Promise<SyncResult> {
    // Fetch PR ref from remote
    await this.git.fetch();
    const localBranch = await this.git.fetchPr(pr.number);

    // Compute diff against base
    const baseRef = `origin/${pr.base_ref}`;
    const rawDiff = await this.git.diff(baseRef, localBranch);

    // Parse diff into chunks
    const fileDiffs = parseDiff(rawDiff);
    const newChunks = flattenChunks(fileDiffs);

    return this.reconcileChunks(pr.id, newChunks);
  }

  /**
   * Reconcile new parsed chunks with existing chunks in the database.
   *
   * Strategy (content-hash based):
   * - Chunks whose content hash still exists in the new diff survive with
   *   all their state (approved, tags, metadata, comments). If their
   *   file position changed, the row is updated in place.
   * - Chunks whose content hash is gone are deleted (CASCADE removes
   *   tags, metadata, and comments).
   * - New content hashes are inserted as fresh unapproved chunks.
   */
  reconcileChunks(
    prId: number,
    newChunks: Array<{
      filePath: string;
      chunkIndex: number;
      contentHash: string;
      diffText: string;
      startLine: number;
      endLine: number;
    }>,
  ): SyncResult {
    // Get existing chunks for this PR
    const existingChunks = this.db
      .prepare('SELECT * FROM chunks WHERE pr_id = ?')
      .all(prId) as ChunkDbRow[];

    const existingByHash = new Map(existingChunks.map((c) => [c.content_hash, c]));
    const newHashes = new Set(newChunks.map((c) => c.contentHash));

    let added = 0;
    let removed = 0;
    let updated = 0;

    const reconcile = this.db.transaction(() => {
      // 1. Delete chunks whose content hash no longer exists in the new diff.
      //    CASCADE removes their tags, metadata, and comments automatically.
      const deleteChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?');
      for (const existing of existingChunks) {
        if (!newHashes.has(existing.content_hash)) {
          deleteChunk.run(existing.id);
          removed++;
        }
      }

      // 2. Update surviving chunks whose position changed.
      //    We must do this before inserting new chunks to avoid UNIQUE
      //    constraint violations on (pr_id, file_path, chunk_index).
      //    Use a temporary sentinel chunk_index = -1 to avoid conflicts
      //    when two chunks swap positions.
      const clearPosition = this.db.prepare(
        'UPDATE chunks SET file_path = ?, chunk_index = -1 WHERE id = ?',
      );
      const updatePosition = this.db.prepare(
        'UPDATE chunks SET file_path = ?, chunk_index = ?, start_line = ?, end_line = ? WHERE id = ?',
      );

      // First pass: move all survivors to sentinel positions
      for (const chunk of newChunks) {
        const existing = existingByHash.get(chunk.contentHash);
        if (
          existing &&
          (existing.file_path !== chunk.filePath || existing.chunk_index !== chunk.chunkIndex)
        ) {
          clearPosition.run(chunk.filePath, existing.id);
        }
      }

      // Second pass: set correct positions + update line ranges
      for (const chunk of newChunks) {
        const existing = existingByHash.get(chunk.contentHash);
        if (existing) {
          if (
            existing.file_path !== chunk.filePath ||
            existing.chunk_index !== chunk.chunkIndex ||
            existing.start_line !== chunk.startLine ||
            existing.end_line !== chunk.endLine
          ) {
            updatePosition.run(
              chunk.filePath,
              chunk.chunkIndex,
              chunk.startLine,
              chunk.endLine,
              existing.id,
            );
            updated++;
          }
          // approved, approvedAt, tags, metadata, comments are all preserved
        }
      }

      // 3. Insert genuinely new chunks (hash not seen before).
      const insertChunk = this.db.prepare(`
        INSERT INTO chunks (pr_id, file_path, chunk_index, content_hash, diff_text, start_line, end_line)
        VALUES (@prId, @filePath, @chunkIndex, @contentHash, @diffText, @startLine, @endLine)
      `);

      for (const chunk of newChunks) {
        if (!existingByHash.has(chunk.contentHash)) {
          insertChunk.run({
            prId,
            filePath: chunk.filePath,
            chunkIndex: chunk.chunkIndex,
            contentHash: chunk.contentHash,
            diffText: chunk.diffText,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
          });
          added++;
        }
      }
    });

    reconcile();

    return { added, removed, updated, outdated: 0 };
  }

  /**
   * Get a PR by its database ID.
   */
  getPr(prId: number): PullRequest | null {
    const row = this.db.prepare('SELECT * FROM prs WHERE id = ?').get(prId) as PrDbRow | undefined;
    return row ? mapPrRow(row) : null;
  }

  /**
   * List all tracked PRs.
   */
  listPrs(): PullRequest[] {
    const rows = this.db.prepare('SELECT * FROM prs ORDER BY updated_at DESC').all() as PrDbRow[];
    return rows.map(mapPrRow);
  }

  /**
   * Delete a tracked PR and all its associated data (cascades).
   */
  deletePr(prId: number): boolean {
    const result = this.db.prepare('DELETE FROM prs WHERE id = ?').run(prId);
    return result.changes > 0;
  }

  /**
   * Submit a review on the PR via the GitHub API.
   * Supports APPROVE and COMMENT events.
   */
  async submitReview(
    prId: number,
    event: ReviewEvent,
    body?: string,
  ): Promise<SubmitReviewResponse> {
    const pr = this.db.prepare('SELECT * FROM prs WHERE id = ?').get(prId) as PrDbRow | undefined;
    if (!pr) {
      throw new Error(`PR not found: ${prId}`);
    }

    const octokit = await getOctokit(pr.gh_host);
    const { data: review } = await octokit.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      event,
      body: body || undefined,
    });

    return {
      id: review.id,
      state: review.state,
      submittedAt: review.submitted_at ?? new Date().toISOString(),
    };
  }
}

// ── DB Row Types ──────────────────────────────────────────────

interface PrDbRow {
  id: number;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: string;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  body: string;
  gh_host: string;
  created_at: string;
  updated_at: string;
}

interface ChunkDbRow {
  id: number;
  pr_id: number;
  file_path: string;
  chunk_index: number;
  content_hash: string;
  diff_text: string;
  start_line: number;
  end_line: number;
  approved: number;
  approved_at: string | null;
}

// ── Helpers ───────────────────────────────────────────────────

function mapGhState(
  state: string,
  merged: boolean | null | undefined,
  draft: boolean | null | undefined,
): PrState {
  if (merged) return 'merged';
  if (draft) return 'draft';
  if (state === 'closed') return 'closed';
  return 'open';
}

function mapPrRow(row: PrDbRow): PullRequest {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    title: row.title,
    author: row.author,
    state: row.state as PrState,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    headSha: row.head_sha,
    body: row.body,
    ghHost: row.gh_host,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
