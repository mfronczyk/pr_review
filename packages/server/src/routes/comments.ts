import type { DatabaseSync } from 'node:sqlite';
import { Router } from 'express';
import { CommentService } from '../services/comment-service.js';

export function createCommentRoutes(db: DatabaseSync): Router {
  const router = Router();
  const commentService = new CommentService({ db });

  /**
   * GET /api/prs/:prId/comments
   * Get all comments for a PR.
   */
  router.get('/prs/:prId/comments', (req, res) => {
    try {
      const comments = commentService.getCommentsForPr(Number(req.params.prId));
      res.json(comments);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/comments
   * Create a new comment on a chunk at a specific line.
   * Body: { chunkId, prId, body, line, side?, parentId? }
   */
  router.post('/comments', (req, res) => {
    try {
      const { chunkId, prId, body, line, side, parentId } = req.body as {
        chunkId: number;
        prId: number;
        body: string;
        line: number;
        side?: 'LEFT' | 'RIGHT';
        parentId?: number;
      };
      if (!chunkId || !prId || !body || line == null) {
        res.status(400).json({ error: 'chunkId, prId, body, and line are required' });
        return;
      }
      const comment = commentService.createComment(
        chunkId,
        prId,
        body,
        line,
        side ?? 'RIGHT',
        parentId,
      );
      res.status(201).json(comment);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * PATCH /api/comments/:id
   * Update a comment body.
   */
  router.patch('/comments/:id', (req, res) => {
    try {
      const { body } = req.body as { body: string };
      if (!body) {
        res.status(400).json({ error: 'body is required' });
        return;
      }
      const comment = commentService.updateComment(Number(req.params.id), body);
      res.json(comment);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * DELETE /api/comments/:id
   * Delete an unpublished comment.
   */
  router.delete('/comments/:id', (req, res) => {
    try {
      const deleted = commentService.deleteComment(Number(req.params.id));
      if (!deleted) {
        res.status(404).json({ error: 'Comment not found' });
        return;
      }
      res.status(204).send();
    } catch (error) {
      const msg = errorMessage(error);
      if (msg.includes('published')) {
        res.status(409).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/comments/:id/publish
   * Publish a comment to GitHub.
   */
  router.post('/comments/:id/publish', async (req, res) => {
    const commentId = Number(req.params.id);
    try {
      const { owner, repo, prNumber, ghHost, commitSha } = req.body as {
        owner: string;
        repo: string;
        prNumber: number;
        ghHost: string;
        commitSha: string;
      };
      if (!owner || !repo || !prNumber || !commitSha) {
        res.status(400).json({
          error: 'owner, repo, prNumber, and commitSha are required',
        });
        return;
      }
      console.log(`[comments] Publishing comment #${commentId} to ${owner}/${repo}#${prNumber}`);
      const comment = await commentService.publishComment(
        commentId,
        owner,
        repo,
        prNumber,
        ghHost || 'github.com',
        commitSha,
      );
      console.log(`[comments] Published comment #${commentId}`);
      res.json(comment);
    } catch (error) {
      console.error(
        `[comments] Failed to publish comment #${commentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/prs/:prId/publish-comments
   * Publish all unpublished comments for a PR.
   */
  router.post('/prs/:prId/publish-comments', async (req, res) => {
    const prId = Number(req.params.prId);
    try {
      const { owner, repo, prNumber, ghHost, commitSha } = req.body as {
        owner: string;
        repo: string;
        prNumber: number;
        ghHost: string;
        commitSha: string;
      };
      if (!owner || !repo || !prNumber || !commitSha) {
        res.status(400).json({
          error: 'owner, repo, prNumber, and commitSha are required',
        });
        return;
      }
      console.log(`[comments] Publishing all comments for PR #${prId}`);
      const count = await commentService.publishAllForPr(
        prId,
        owner,
        repo,
        prNumber,
        ghHost || 'github.com',
        commitSha,
      );
      console.log(`[comments] Published ${count} comments for PR #${prId}`);
      res.json({ published: count });
    } catch (error) {
      console.error(
        `[comments] Failed to publish comments for PR #${prId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/comments/:id/resolve
   * Resolve a comment thread. If published to GitHub, also resolves it there.
   */
  router.post('/comments/:id/resolve', async (req, res) => {
    const commentId = Number(req.params.id);
    try {
      const comment = await commentService.resolveThread(commentId);
      res.json(comment);
    } catch (error) {
      const msg = errorMessage(error);
      if (msg.includes('not found')) {
        res.status(404).json({ error: msg });
        return;
      }
      console.error(`[comments] Failed to resolve thread #${commentId}: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/comments/:id/unresolve
   * Unresolve a comment thread. If published to GitHub, also unresolves it there.
   */
  router.post('/comments/:id/unresolve', async (req, res) => {
    const commentId = Number(req.params.id);
    try {
      const comment = await commentService.unresolveThread(commentId);
      res.json(comment);
    } catch (error) {
      const msg = errorMessage(error);
      if (msg.includes('not found')) {
        res.status(404).json({ error: msg });
        return;
      }
      console.error(`[comments] Failed to unresolve thread #${commentId}: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
