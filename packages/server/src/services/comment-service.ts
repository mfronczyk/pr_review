import type { Comment } from '@pr-review/shared';
import type Database from 'better-sqlite3';
import { getOctokit } from './github-client.js';

export interface CommentServiceOptions {
  db: Database.Database;
}

/**
 * Service for comment CRUD and GitHub publishing.
 */
export class CommentService {
  private readonly db: Database.Database;

  constructor(options: CommentServiceOptions) {
    this.db = options.db;
  }

  /**
   * Create a new local comment on a chunk.
   */
  createComment(chunkId: number, prId: number, body: string): Comment {
    const row = this.db
      .prepare(
        `INSERT INTO comments (chunk_id, pr_id, body)
       VALUES (?, ?, ?)
       RETURNING *`,
      )
      .get(chunkId, prId, body) as CommentDbRow;

    return mapCommentRow(row);
  }

  /**
   * Update a comment body.
   */
  updateComment(commentId: number, body: string): Comment {
    this.db.prepare('UPDATE comments SET body = ? WHERE id = ?').run(body, commentId);
    const row = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId) as
      | CommentDbRow
      | undefined;
    if (!row) throw new Error(`Comment not found: ${commentId}`);
    return mapCommentRow(row);
  }

  /**
   * Delete a comment. Only allows deleting unpublished comments.
   */
  deleteComment(commentId: number): boolean {
    const row = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId) as
      | CommentDbRow
      | undefined;
    if (!row) return false;
    if (row.published_at) {
      throw new Error('Cannot delete a published comment. Delete it on GitHub instead.');
    }
    const result = this.db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
    return result.changes > 0;
  }

  /**
   * Get all comments for a PR.
   */
  getCommentsForPr(prId: number): Comment[] {
    const rows = this.db
      .prepare('SELECT * FROM comments WHERE pr_id = ? ORDER BY created_at')
      .all(prId) as CommentDbRow[];
    return rows.map(mapCommentRow);
  }

  /**
   * Publish a single comment to GitHub as a PR review comment.
   *
   * Uses the chunk's file path and line range to anchor the comment
   * to the correct location in the diff.
   */
  async publishComment(
    commentId: number,
    owner: string,
    repo: string,
    prNumber: number,
    ghHost: string,
    commitSha: string,
  ): Promise<Comment> {
    const comment = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId) as
      | CommentDbRow
      | undefined;
    if (!comment) throw new Error(`Comment not found: ${commentId}`);
    if (comment.published_at) throw new Error('Comment already published');

    // Get the chunk to know the file path and line
    const chunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(comment.chunk_id) as
      | { file_path: string; end_line: number }
      | undefined;
    if (!chunk) throw new Error(`Chunk not found for comment: ${commentId}`);

    const octokit = await getOctokit(ghHost);

    const { data: ghComment } = await octokit.pulls.createReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      body: comment.body,
      commit_id: commitSha,
      path: chunk.file_path,
      line: chunk.end_line,
      side: 'RIGHT',
    });

    this.db
      .prepare("UPDATE comments SET gh_comment_id = ?, published_at = datetime('now') WHERE id = ?")
      .run(ghComment.id, commentId);

    const updated = this.db
      .prepare('SELECT * FROM comments WHERE id = ?')
      .get(commentId) as CommentDbRow;
    return mapCommentRow(updated);
  }

  /**
   * Publish all unpublished comments for a PR.
   */
  async publishAllForPr(
    prId: number,
    owner: string,
    repo: string,
    prNumber: number,
    ghHost: string,
    commitSha: string,
  ): Promise<number> {
    const unpublished = this.db
      .prepare('SELECT id FROM comments WHERE pr_id = ? AND published_at IS NULL')
      .all(prId) as Array<{ id: number }>;

    let published = 0;
    for (const { id } of unpublished) {
      await this.publishComment(id, owner, repo, prNumber, ghHost, commitSha);
      published++;
    }
    return published;
  }
}

// ── DB Row Type ───────────────────────────────────────────────

interface CommentDbRow {
  id: number;
  chunk_id: number;
  pr_id: number;
  body: string;
  gh_comment_id: number | null;
  created_at: string;
  published_at: string | null;
}

// ── Mapper ────────────────────────────────────────────────────

function mapCommentRow(row: CommentDbRow): Comment {
  return {
    id: row.id,
    chunkId: row.chunk_id,
    prId: row.pr_id,
    body: row.body,
    ghCommentId: row.gh_comment_id,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}
