import type { AddPrRequest, PrWithProgress } from '@pr-review/shared';
import type Database from 'better-sqlite3';
import { Router } from 'express';
import { ChunkService } from '../services/chunk-service.js';
import { parseDiff } from '../services/diff-parser.js';
import { GitService } from '../services/git.js';
import { analyzePr } from '../services/llm-analyzer.js';
import { PrService } from '../services/pr-service.js';

export function createPrRoutes(db: Database.Database, repoPath: string): Router {
  const router = Router();
  const prService = new PrService({ db, repoPath });
  const chunkService = new ChunkService({ db });

  /**
   * GET /api/prs
   * List all tracked PRs with review progress.
   */
  router.get('/', (_req, res) => {
    try {
      const prs = prService.listPrs();
      const result: PrWithProgress[] = prs.map((pr) => {
        const chunks = chunkService.getChunksForPr(pr.id);
        return {
          ...pr,
          totalChunks: chunks.length,
          approvedChunks: chunks.filter((c) => c.approved).length,
        };
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/prs
   * Add a new PR to track.
   */
  router.post('/', async (req, res) => {
    try {
      const body = req.body as AddPrRequest;
      if (!body.owner || !body.repo || !body.number) {
        res.status(400).json({ error: 'owner, repo, and number are required' });
        return;
      }
      const pr = await prService.addPr(body.owner, body.repo, body.number, body.ghHost);
      res.status(201).json(pr);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * GET /api/prs/:id
   * Get a single PR.
   */
  router.get('/:id', (req, res) => {
    try {
      const pr = prService.getPr(Number(req.params.id));
      if (!pr) {
        res.status(404).json({ error: 'PR not found' });
        return;
      }
      const chunks = chunkService.getChunksForPr(pr.id);
      const result: PrWithProgress = {
        ...pr,
        totalChunks: chunks.length,
        approvedChunks: chunks.filter((c) => c.approved).length,
      };
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * DELETE /api/prs/:id
   * Remove a tracked PR.
   */
  router.delete('/:id', (req, res) => {
    try {
      const deleted = prService.deletePr(Number(req.params.id));
      if (!deleted) {
        res.status(404).json({ error: 'PR not found' });
        return;
      }
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/prs/:id/sync
   * Re-fetch PR metadata and diff, update chunks.
   */
  router.post('/:id/sync', async (req, res) => {
    try {
      const prId = Number(req.params.id);
      const result = await prService.syncPr(prId);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/prs/:id/analyze
   * Run LLM analysis on a PR's chunks.
   */
  router.post('/:id/analyze', async (req, res) => {
    try {
      const prId = Number(req.params.id);
      const pr = prService.getPr(prId);
      if (!pr) {
        res.status(404).json({ error: 'PR not found' });
        return;
      }

      // Get the diff from local git
      const git = new GitService({ repoPath });
      const localBranch = `pr-${pr.number}`;
      const baseRef = `origin/${pr.baseRef}`;

      // Ensure we have the branch
      const branchExists = await git.refExists(localBranch);
      if (!branchExists) {
        await git.fetchPr(pr.number);
      }

      const rawDiff = await git.diff(baseRef, localBranch);
      const fileDiffs = parseDiff(rawDiff);

      const result = await analyzePr(
        { db, repoPath },
        prId,
        pr.title,
        pr.body,
        pr.author,
        pr.baseRef,
        fileDiffs,
      );

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  return router;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
