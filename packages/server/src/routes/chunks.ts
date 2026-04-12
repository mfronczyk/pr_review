import type Database from 'better-sqlite3';
import { Router } from 'express';
import { ChunkService } from '../services/chunk-service.js';

export function createChunkRoutes(db: Database.Database): Router {
  const router = Router();
  const chunkService = new ChunkService({ db });

  /**
   * GET /api/prs/:prId/chunks
   * Get all chunks for a PR with details.
   */
  router.get('/prs/:prId/chunks', (req, res) => {
    try {
      const chunks = chunkService.getChunksForPr(Number(req.params.prId));
      res.json(chunks);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * GET /api/chunks/:id
   * Get a single chunk with details.
   */
  router.get('/chunks/:id', (req, res) => {
    try {
      const chunk = chunkService.getChunk(Number(req.params.id));
      if (!chunk) {
        res.status(404).json({ error: 'Chunk not found' });
        return;
      }
      res.json(chunk);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * PATCH /api/chunks/:id/approved
   * Toggle chunk approved state.
   */
  router.patch('/chunks/:id/approved', (req, res) => {
    try {
      const chunk = chunkService.toggleApproved(Number(req.params.id));
      res.json(chunk);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * PATCH /api/chunks/:id/metadata
   * Update chunk priority and/or review note.
   */
  router.patch('/chunks/:id/metadata', (req, res) => {
    try {
      const { priority, reviewNote } = req.body as {
        priority?: string;
        reviewNote?: string | null;
      };
      chunkService.updateMetadata(
        Number(req.params.id),
        priority as 'high' | 'medium' | 'low' | undefined,
        reviewNote,
      );
      const chunk = chunkService.getChunk(Number(req.params.id));
      res.json(chunk);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * PUT /api/chunks/:id/tags
   * Replace all tags on a chunk.
   */
  router.put('/chunks/:id/tags', (req, res) => {
    try {
      const { tagIds } = req.body as { tagIds: number[] };
      if (!Array.isArray(tagIds)) {
        res.status(400).json({ error: 'tagIds must be an array of numbers' });
        return;
      }
      chunkService.setChunkTags(Number(req.params.id), tagIds);
      const chunk = chunkService.getChunk(Number(req.params.id));
      res.json(chunk);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/prs/:prId/bulk-approve
   * Bulk approve all chunks with a given tag.
   */
  router.post('/prs/:prId/bulk-approve', (req, res) => {
    try {
      const { tagId } = req.body as { tagId: number };
      if (!tagId) {
        res.status(400).json({ error: 'tagId is required' });
        return;
      }
      const count = chunkService.bulkApproveByTag(Number(req.params.prId), tagId);
      res.json({ approved: count });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/prs/:prId/bulk-unapprove
   * Bulk unapprove all chunks with a given tag.
   */
  router.post('/prs/:prId/bulk-unapprove', (req, res) => {
    try {
      const { tagId } = req.body as { tagId: number };
      if (!tagId) {
        res.status(400).json({ error: 'tagId is required' });
        return;
      }
      const count = chunkService.bulkUnapproveByTag(Number(req.params.prId), tagId);
      res.json({ unapproved: count });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * GET /api/prs/:prId/tags
   * Get all tags for a PR.
   */
  router.get('/prs/:prId/tags', (req, res) => {
    try {
      const tags = chunkService.getTagsForPr(Number(req.params.prId));
      res.json(tags);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  return router;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
