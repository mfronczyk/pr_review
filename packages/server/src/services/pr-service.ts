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
        updated_at = datetime('now'),
        synced_at = datetime('now')
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

    // 5. Import existing GitHub review comments
    const commentService = new CommentService({ db: this.db });
    await commentService.importGitHubComments(pr.id, owner, repo, prNumber, ghHost);

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
       head_sha = ?, body = ?, updated_at = datetime('now'), synced_at = datetime('now') WHERE id = ?`,
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

    // Skip diff recomputation for terminal states — the diff won't change,
    // and the git refs (pull/<N>/head) may no longer be fetchable if the
    // source branch or fork was deleted.
    if (state === 'merged' || state === 'closed') {
      return { added: 0, removed: 0 };
    }

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
   * Fetch the PR via git, compute diff, parse into chunks,
   * and reconcile with the database.
   * Uses the headSha already stored in the PR row — no local branches created.
   */
  private async fetchAndStoreDiff(pr: PrDbRow): Promise<SyncResult> {
    // Fetch PR ref from remote (resolves to a SHA, no local branch)
    await this.git.fetch();
    await this.git.fetchPr(pr.number);

    // Compute diff using the known head SHA from GitHub
    const baseRef = `origin/${pr.base_ref}`;
    const rawDiff = await this.git.diff(baseRef, pr.head_sha);

    // Compute commit count while we have the refs available
    const commits = await this.git.getCommitLog(baseRef, pr.head_sha);
    this.db
      .prepare("UPDATE prs SET commit_count = ?, synced_at = datetime('now') WHERE id = ?")
      .run(commits.length, pr.id);

    // Parse diff into chunks
    const fileDiffs = parseDiff(rawDiff);
    const newChunks = flattenChunks(fileDiffs);

    return this.reconcileChunks(pr.id, newChunks);
  }

  /**
   * Reconcile new parsed chunks with existing chunks in the database.
   *
   * Strategy (delete-and-recreate):
   * - All existing chunk rows are deleted (comments CASCADE with them).
   * - All new chunks are inserted fresh.
   * - Approval state, tags, and metadata are stored in separate tables
   *   keyed by (pr_id, content_hash), so they survive chunk recreation
   *   automatically — no explicit preservation needed.
   * - Comments are re-imported from GitHub after sync (in syncPr/addPr).
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
      oldStartLine?: number;
      oldEndLine?: number;
      fileStatus?: string;
    }>,
  ): SyncResult {
    // Collect existing hashes to compute added/removed counts
    const existingHashes = new Set(
      (
        this.db.prepare('SELECT content_hash FROM chunks WHERE pr_id = ?').all(prId) as Array<{
          content_hash: string;
        }>
      ).map((r) => r.content_hash),
    );

    const newHashes = new Set(newChunks.map((c) => c.contentHash));

    let added = 0;
    let removed = 0;

    for (const h of newHashes) {
      if (!existingHashes.has(h)) added++;
    }
    for (const h of existingHashes) {
      if (!newHashes.has(h)) removed++;
    }

    const reconcile = this.db.transaction(() => {
      // 1. Delete all existing chunks (comments CASCADE-delete with them)
      this.db.prepare('DELETE FROM chunks WHERE pr_id = ?').run(prId);

      // 2. Insert all new chunks
      const insertChunk = this.db.prepare(`
        INSERT INTO chunks (pr_id, file_path, chunk_index, content_hash, diff_text, start_line, end_line, old_start_line, old_end_line, file_status)
        VALUES (@prId, @filePath, @chunkIndex, @contentHash, @diffText, @startLine, @endLine, @oldStartLine, @oldEndLine, @fileStatus)
      `);

      for (const chunk of newChunks) {
        insertChunk.run({
          prId,
          filePath: chunk.filePath,
          chunkIndex: chunk.chunkIndex,
          contentHash: chunk.contentHash,
          diffText: chunk.diffText,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          oldStartLine: chunk.oldStartLine ?? 0,
          oldEndLine: chunk.oldEndLine ?? 0,
          fileStatus: chunk.fileStatus ?? 'modified',
        });
      }

      // 3. Clean up orphaned hash-keyed rows for hashes no longer present.
      //    This prevents unbounded growth of chunk_reviews, chunk_tags, and
      //    chunk_metadata when chunk content changes across syncs.
      const activeHashes = this.db
        .prepare('SELECT DISTINCT content_hash FROM chunks WHERE pr_id = ?')
        .all(prId) as Array<{ content_hash: string }>;
      const activeHashSet = new Set(activeHashes.map((r) => r.content_hash));

      const cleanupTable = (table: string): void => {
        const orphans = this.db
          .prepare(`SELECT DISTINCT content_hash FROM ${table} WHERE pr_id = ?`)
          .all(prId) as Array<{ content_hash: string }>;

        const deleteStmt = this.db.prepare(
          `DELETE FROM ${table} WHERE pr_id = ? AND content_hash = ?`,
        );
        for (const row of orphans) {
          if (!activeHashSet.has(row.content_hash)) {
            deleteStmt.run(prId, row.content_hash);
          }
        }
      };

      cleanupTable('chunk_reviews');
      cleanupTable('chunk_tags');
      cleanupTable('chunk_metadata');

      // 4. Assign the 'unassigned' tag to any chunks that have no tags
      //    (checked via content_hash in chunk_tags, not chunk_id).
      const untaggedChunks = this.db
        .prepare(
          `SELECT c.id, c.content_hash FROM chunks c
           WHERE c.pr_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM chunk_tags ct
               WHERE ct.pr_id = c.pr_id AND ct.content_hash = c.content_hash
             )`,
        )
        .all(prId) as Array<{ id: number; content_hash: string }>;

      if (untaggedChunks.length > 0) {
        const getOrCreateTag = this.db.prepare(`
          INSERT INTO tags (name, description, pr_id)
          VALUES (@name, @description, @prId)
          ON CONFLICT (name, pr_id) DO UPDATE SET description = description
          RETURNING id
        `);

        const unassignedTag = getOrCreateTag.get({
          name: 'unassigned',
          description: 'Chunks not categorized by LLM analysis',
          prId,
        }) as { id: number };

        const insertChunkTag = this.db.prepare(
          'INSERT OR IGNORE INTO chunk_tags (pr_id, content_hash, tag_id) VALUES (?, ?, ?)',
        );

        for (const chunk of untaggedChunks) {
          insertChunkTag.run(prId, chunk.content_hash, unassignedTag.id);
        }
      }
    });

    reconcile();

    return { added, removed };
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
  commit_count: number;
  created_at: string;
  updated_at: string;
  synced_at: string;
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
    commitCount: row.commit_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}
