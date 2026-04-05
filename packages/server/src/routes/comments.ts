import type Database from 'better-sqlite3';
import { Router } from 'express';
import { CommentService } from '../services/comment-service.js';

export function createCommentRoutes(db: Database.Database): Router {
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
   * Create a new comment on a chunk.
   */
  router.post('/comments', (req, res) => {
    try {
      const { chunkId, prId, body } = req.body as {
        chunkId: number;
        prId: number;
        body: string;
      };
      if (!chunkId || !prId || !body) {
        res.status(400).json({ error: 'chunkId, prId, and body are required' });
        return;
      }
      const comment = commentService.createComment(chunkId, prId, body);
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
      const comment = await commentService.publishComment(
        Number(req.params.id),
        owner,
        repo,
        prNumber,
        ghHost || 'github.com',
        commitSha,
      );
      res.json(comment);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/prs/:prId/publish-comments
   * Publish all unpublished comments for a PR.
   */
  router.post('/prs/:prId/publish-comments', async (req, res) => {
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
      const count = await commentService.publishAllForPr(
        Number(req.params.prId),
        owner,
        repo,
        prNumber,
        ghHost || 'github.com',
        commitSha,
      );
      res.json({ published: count });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  return router;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
