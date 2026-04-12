import type { Comment, DiffSide } from '@pr-review/shared';
import type Database from 'better-sqlite3';
import { getOctokit } from './github-client.js';

export interface CommentServiceOptions {
  db: Database.Database;
}

/**
 * Service for threaded comment CRUD, resolve/unresolve, and GitHub publishing.
 *
 * Comments are anchored to a specific line within a chunk, on either the
 * old-file side (LEFT) or new-file side (RIGHT) of the diff.
 * A thread is a root comment (parentId = null) plus flat replies (parentId = root.id).
 */
export class CommentService {
  private readonly db: Database.Database;

  constructor(options: CommentServiceOptions) {
    this.db = options.db;
  }

  /**
   * Create a new local comment on a chunk at a specific line.
   * If parentId is provided, this is a reply to an existing thread root.
   */
  createComment(
    chunkId: number,
    prId: number,
    body: string,
    line: number,
    side: DiffSide = 'RIGHT',
    parentId?: number | null,
  ): Comment {
    if (parentId != null) {
      const parent = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(parentId) as
        | CommentDbRow
        | undefined;
      if (!parent) {
        throw new Error(`Parent comment not found: ${parentId}`);
      }
      if (parent.parent_id != null) {
        throw new Error('Cannot reply to a reply — only root comments can have replies');
      }
      if (parent.chunk_id !== chunkId) {
        throw new Error('Reply must belong to the same chunk as the parent');
      }
    }

    const row = this.db
      .prepare(
        `INSERT INTO comments (chunk_id, pr_id, body, line, side, parent_id)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
      )
      .get(chunkId, prId, body, line, side, parentId ?? null) as CommentDbRow;

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
   * If deleting a root comment, cascade-deletes all replies (handled by FK CASCADE).
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
   * Resolve a thread (set resolved = 1 on the root comment).
   * If the comment has been published to GitHub, also resolves the thread on GitHub.
   */
  async resolveThread(commentId: number): Promise<Comment> {
    const row = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId) as
      | CommentDbRow
      | undefined;
    if (!row) throw new Error(`Comment not found: ${commentId}`);
    if (row.parent_id != null) {
      throw new Error('Can only resolve root comments (thread roots)');
    }
    this.db.prepare('UPDATE comments SET resolved = 1 WHERE id = ?').run(commentId);

    // Sync resolution to GitHub if the comment has a node ID
    if (row.gh_node_id) {
      await this.syncThreadResolution(row.gh_node_id, row.pr_id, 'resolve');
    }

    const updated = this.db
      .prepare('SELECT * FROM comments WHERE id = ?')
      .get(commentId) as CommentDbRow;
    return mapCommentRow(updated);
  }

  /**
   * Unresolve a thread (set resolved = 0 on the root comment).
   * If the comment has been published to GitHub, also unresolves the thread on GitHub.
   */
  async unresolveThread(commentId: number): Promise<Comment> {
    const row = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId) as
      | CommentDbRow
      | undefined;
    if (!row) throw new Error(`Comment not found: ${commentId}`);
    if (row.parent_id != null) {
      throw new Error('Can only unresolve root comments (thread roots)');
    }
    this.db.prepare('UPDATE comments SET resolved = 0 WHERE id = ?').run(commentId);

    // Sync resolution to GitHub if the comment has a node ID
    if (row.gh_node_id) {
      await this.syncThreadResolution(row.gh_node_id, row.pr_id, 'unresolve');
    }

    const updated = this.db
      .prepare('SELECT * FROM comments WHERE id = ?')
      .get(commentId) as CommentDbRow;
    return mapCommentRow(updated);
  }

  /**
   * Sync thread resolution state to GitHub via GraphQL.
   * Queries the PR's review threads to find the one containing the given comment,
   * then calls resolveReviewThread or unresolveReviewThread.
   */
  private async syncThreadResolution(
    commentNodeId: string,
    prId: number,
    action: 'resolve' | 'unresolve',
  ): Promise<void> {
    const pr = this.db
      .prepare('SELECT owner, repo, number, gh_host FROM prs WHERE id = ?')
      .get(prId) as { owner: string; repo: string; number: number; gh_host: string } | undefined;
    if (!pr) return;

    const octokit = await getOctokit(pr.gh_host);

    // Query the PR's review threads to find the one containing our comment
    const result = await octokit.graphql<{
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array<{
              id: string;
              comments: { nodes: Array<{ id: string }> };
            }>;
          };
        };
      };
    }>(
      `query($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            reviewThreads(first: 100) {
              nodes {
                id
                comments(first: 1) {
                  nodes { id }
                }
              }
            }
          }
        }
      }`,
      { owner: pr.owner, repo: pr.repo, prNumber: pr.number },
    );

    const threads = result.repository.pullRequest.reviewThreads.nodes;
    const thread = threads.find((t) => t.comments.nodes.some((c) => c.id === commentNodeId));

    if (!thread) {
      console.warn(
        `[comments] Could not find GitHub thread for comment node ${commentNodeId}, skipping sync`,
      );
      return;
    }

    if (action === 'resolve') {
      await octokit.graphql(
        `mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { id isResolved }
          }
        }`,
        { threadId: thread.id },
      );
    } else {
      await octokit.graphql(
        `mutation($threadId: ID!) {
          unresolveReviewThread(input: { threadId: $threadId }) {
            thread { id isResolved }
          }
        }`,
        { threadId: thread.id },
      );
    }
  }

  /**
   * Publish a single comment to GitHub as a PR review comment.
   *
   * Root comments: uses createReviewComment with line, path, and side from the comment.
   * Replies: uses createReplyForReviewComment with in_reply_to = parent's gh_comment_id.
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

    const octokit = await getOctokit(ghHost);

    if (comment.parent_id != null) {
      // This is a reply — find parent's gh_comment_id
      const parent = this.db
        .prepare('SELECT * FROM comments WHERE id = ?')
        .get(comment.parent_id) as CommentDbRow | undefined;
      if (!parent) throw new Error(`Parent comment not found: ${comment.parent_id}`);
      if (!parent.gh_comment_id) {
        throw new Error('Cannot publish reply — parent comment has not been published yet');
      }

      const { data: ghComment } = await octokit.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        comment_id: parent.gh_comment_id,
        body: comment.body,
      });

      this.db
        .prepare(
          `UPDATE comments SET gh_comment_id = ?, gh_node_id = ?, published_at = datetime('now')
           WHERE id = ?`,
        )
        .run(ghComment.id, ghComment.node_id, commentId);
    } else {
      // Root comment — anchor to file line
      const chunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(comment.chunk_id) as
        | { file_path: string }
        | undefined;
      if (!chunk) throw new Error(`Chunk not found for comment: ${commentId}`);

      const { data: ghComment } = await octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        body: comment.body,
        commit_id: commitSha,
        path: chunk.file_path,
        line: comment.line,
        side: comment.side as DiffSide,
      });

      this.db
        .prepare(
          `UPDATE comments SET gh_comment_id = ?, gh_node_id = ?, published_at = datetime('now')
           WHERE id = ?`,
        )
        .run(ghComment.id, ghComment.node_id, commentId);
    }

    const updated = this.db
      .prepare('SELECT * FROM comments WHERE id = ?')
      .get(commentId) as CommentDbRow;
    return mapCommentRow(updated);
  }

  /**
   * Publish all unpublished comments for a PR.
   * Publishes root comments first, then replies (so parents have gh_comment_id).
   */
  async publishAllForPr(
    prId: number,
    owner: string,
    repo: string,
    prNumber: number,
    ghHost: string,
    commitSha: string,
  ): Promise<number> {
    // Roots first (parent_id IS NULL), then replies
    const unpublished = this.db
      .prepare(
        `SELECT id FROM comments
       WHERE pr_id = ? AND published_at IS NULL
       ORDER BY parent_id IS NOT NULL, created_at`,
      )
      .all(prId) as Array<{ id: number }>;

    let published = 0;
    for (const { id } of unpublished) {
      await this.publishComment(id, owner, repo, prNumber, ghHost, commitSha);
      published++;
    }
    return published;
  }

  /**
   * Import GitHub review comments during sync.
   * Matches existing comments by gh_comment_id to avoid duplicates.
   * New comments are inserted with their author set.
   */
  async importGitHubComments(
    prId: number,
    owner: string,
    repo: string,
    prNumber: number,
    ghHost: string,
  ): Promise<number> {
    const octokit = await getOctokit(ghHost);

    // Fetch all review comments from GitHub
    const ghComments = await octokit.paginate(octokit.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    // Get existing gh_comment_ids to avoid duplicates
    const existingGhIds = new Set(
      (
        this.db
          .prepare(
            'SELECT gh_comment_id FROM comments WHERE pr_id = ? AND gh_comment_id IS NOT NULL',
          )
          .all(prId) as Array<{ gh_comment_id: number }>
      ).map((r) => r.gh_comment_id),
    );

    // Build a map from file_path to chunks for this PR
    const chunks = this.db
      .prepare(
        'SELECT id, file_path, start_line, end_line, old_start_line, old_end_line FROM chunks WHERE pr_id = ?',
      )
      .all(prId) as Array<{
      id: number;
      file_path: string;
      start_line: number;
      end_line: number;
      old_start_line: number;
      old_end_line: number;
    }>;

    // Map gh_comment_id to local comment id (for threading)
    const ghIdToLocalId = new Map<number, number>();
    const existingComments = this.db
      .prepare(
        'SELECT id, gh_comment_id FROM comments WHERE pr_id = ? AND gh_comment_id IS NOT NULL',
      )
      .all(prId) as Array<{ id: number; gh_comment_id: number }>;
    for (const c of existingComments) {
      ghIdToLocalId.set(c.gh_comment_id, c.id);
    }

    let imported = 0;

    for (const ghComment of ghComments) {
      if (existingGhIds.has(ghComment.id)) continue;

      // Find the chunk this comment belongs to.
      // LEFT-side comments (on deleted lines) use old-side line ranges;
      // RIGHT-side comments (on added/context lines) use new-side line ranges.
      const commentLine = ghComment.line ?? ghComment.original_line ?? 0;
      const commentSide = (ghComment.side === 'LEFT' ? 'LEFT' : 'RIGHT') as DiffSide;
      const commentPath = ghComment.path;
      const chunk = chunks.find((c) => {
        if (c.file_path !== commentPath) return false;
        if (commentSide === 'LEFT') {
          return commentLine >= c.old_start_line && commentLine <= c.old_end_line;
        }
        return commentLine >= c.start_line && commentLine <= c.end_line;
      });
      if (!chunk) continue; // Comment is on a line we don't have a chunk for

      // Determine parent_id for threaded replies
      let parentId: number | null = null;
      if (ghComment.in_reply_to_id) {
        parentId = ghIdToLocalId.get(ghComment.in_reply_to_id) ?? null;
      }

      const row = this.db
        .prepare(
          `INSERT INTO comments (chunk_id, pr_id, body, line, side, parent_id, author, gh_comment_id, gh_node_id, published_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
        )
        .get(
          chunk.id,
          prId,
          ghComment.body,
          commentLine,
          commentSide,
          parentId,
          ghComment.user?.login ?? 'unknown',
          ghComment.id,
          ghComment.node_id,
          ghComment.created_at,
          ghComment.created_at,
        ) as CommentDbRow;

      ghIdToLocalId.set(ghComment.id, row.id);
      existingGhIds.add(ghComment.id);
      imported++;
    }

    // Sync thread resolution state from GitHub
    await this.syncResolutionStateFromGitHub(prId, owner, repo, prNumber, octokit);

    return imported;
  }

  /**
   * Fetch thread resolution state from GitHub via GraphQL and update local comments.
   * Matches threads to local root comments by comparing the first comment's node_id.
   */
  private async syncResolutionStateFromGitHub(
    prId: number,
    owner: string,
    repo: string,
    prNumber: number,
    octokit: Awaited<ReturnType<typeof getOctokit>>,
  ): Promise<void> {
    // Get local root comments that have a gh_node_id
    const localRoots = this.db
      .prepare(
        'SELECT id, gh_node_id, resolved FROM comments WHERE pr_id = ? AND parent_id IS NULL AND gh_node_id IS NOT NULL',
      )
      .all(prId) as Array<{ id: number; gh_node_id: string; resolved: number }>;

    if (localRoots.length === 0) return;

    const localByNodeId = new Map<string, { id: number; resolved: number }>();
    for (const root of localRoots) {
      localByNodeId.set(root.gh_node_id, { id: root.id, resolved: root.resolved });
    }

    // Fetch thread resolution state from GitHub
    const result = await octokit.graphql<{
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array<{
              isResolved: boolean;
              comments: { nodes: Array<{ id: string }> };
            }>;
          };
        };
      };
    }>(
      `query($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                comments(first: 1) {
                  nodes { id }
                }
              }
            }
          }
        }
      }`,
      { owner, repo, prNumber },
    );

    const threads = result.repository.pullRequest.reviewThreads.nodes;

    const updateResolved = this.db.prepare('UPDATE comments SET resolved = ? WHERE id = ?');

    for (const thread of threads) {
      const firstComment = thread.comments.nodes[0];
      if (!firstComment) continue;

      const local = localByNodeId.get(firstComment.id);
      if (!local) continue;

      const ghResolved = thread.isResolved ? 1 : 0;
      if (local.resolved !== ghResolved) {
        updateResolved.run(ghResolved, local.id);
      }
    }
  }
}

// ── DB Row Type ───────────────────────────────────────────────

interface CommentDbRow {
  id: number;
  chunk_id: number;
  pr_id: number;
  body: string;
  line: number;
  side: string;
  parent_id: number | null;
  author: string | null;
  gh_comment_id: number | null;
  gh_node_id: string | null;
  resolved: number;
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
    line: row.line,
    side: (row.side === 'LEFT' ? 'LEFT' : 'RIGHT') as DiffSide,
    parentId: row.parent_id,
    author: row.author,
    ghCommentId: row.gh_comment_id,
    ghNodeId: row.gh_node_id,
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}
