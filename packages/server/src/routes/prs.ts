import type {
  AddPrRequest,
  ImportAnalysisRequest,
  LlmModelInfo,
  PrWithProgress,
  PromptDownloadResponse,
  ReviewEvent,
  SubmitReviewRequest,
  TagSummary,
} from '@pr-review/shared';
import type Database from 'better-sqlite3';
import { Router } from 'express';
import { ChunkService } from '../services/chunk-service.js';
import { parseDiff } from '../services/diff-parser.js';
import { GitService } from '../services/git.js';
import {
  analyzePr,
  buildExportablePrompt,
  mapTaggingResult,
  storeChunkMetadata,
} from '../services/llm-analyzer.js';
import { PrService } from '../services/pr-service.js';

export function createPrRoutes(
  db: Database.Database,
  repoPath: string,
  modelInfo?: LlmModelInfo,
): Router {
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
        const { additions, deletions } = chunkService.getDiffStats(pr.id);
        return {
          ...pr,
          totalChunks: chunks.length,
          approvedChunks: chunks.filter((c) => c.approved).length,
          additions,
          deletions,
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
      console.log(`[prs] Adding PR: ${body.owner}/${body.repo}#${body.number}`);
      const pr = await prService.addPr(body.owner, body.repo, body.number, body.ghHost);
      res.status(201).json(pr);
    } catch (error) {
      console.error(
        `[prs] Failed to add PR: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      const { additions, deletions } = chunkService.getDiffStats(pr.id);
      const result: PrWithProgress = {
        ...pr,
        totalChunks: chunks.length,
        approvedChunks: chunks.filter((c) => c.approved).length,
        additions,
        deletions,
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
    const prId = Number(req.params.id);
    try {
      console.log(`[prs] Syncing PR #${prId}...`);
      const result = await prService.syncPr(prId);
      console.log(`[prs] Sync complete for #${prId}`);
      res.json(result);
    } catch (error) {
      console.error(
        `[prs] Failed to sync PR #${prId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/prs/:id/analyze
   * Run LLM analysis on a PR's chunks.
   */
  router.post('/:id/analyze', async (req, res) => {
    try {
      if (!modelInfo) {
        res.status(503).json({
          error:
            'LLM analysis is not available. Start the server with LLM_MODEL=provider/model to enable it.',
        });
        return;
      }

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

      // Get commit messages for additional context
      const commitMessages = await git.getCommitLog(baseRef, localBranch);

      const result = await analyzePr(
        { db, repoPath },
        prId,
        pr.title,
        pr.body,
        pr.author,
        pr.baseRef,
        pr.headRef,
        commitMessages,
        fileDiffs,
        modelInfo,
      );

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * GET /api/prs/:id/tag-summaries
   * Get contextual tag summaries for a PR (generated by LLM analysis).
   */
  router.get('/:id/tag-summaries', (req, res) => {
    try {
      const prId = Number(req.params.id);
      const rows = db
        .prepare(
          `SELECT ts.tag_id, t.name AS tag_name, ts.summary
           FROM tag_summaries ts
           JOIN tags t ON t.id = ts.tag_id
           WHERE ts.pr_id = ?`,
        )
        .all(prId) as Array<{ tag_id: number; tag_name: string; summary: string }>;

      const result: TagSummary[] = rows.map((r) => ({
        tagId: r.tag_id,
        tagName: r.tag_name,
        summary: r.summary,
      }));

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/prs/:id/submit-review
   * Submit a review on the PR (APPROVE or COMMENT).
   */
  router.post('/:id/submit-review', async (req, res) => {
    const prId = Number(req.params.id);
    try {
      const { event, body } = req.body as SubmitReviewRequest;

      const validEvents: ReviewEvent[] = ['APPROVE', 'COMMENT'];
      if (!event || !validEvents.includes(event)) {
        res.status(400).json({ error: 'event must be "APPROVE" or "COMMENT"' });
        return;
      }

      console.log(`[prs] Submitting review for PR #${prId} (${event})`);
      const result = await prService.submitReview(prId, event, body);
      console.log(`[prs] Review submitted for PR #${prId}: ${result.state}`);
      res.json(result);
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('PR not found')) {
        res.status(404).json({ error: message });
        return;
      }
      console.error(`[prs] Failed to submit review for PR #${prId}: ${message}`);
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/prs/:id/context
   * Get file content lines at the PR's head revision for expanding diff context.
   *
   * Query params:
   *   filePath  - path of the file in the repo
   *   startLine - 1-indexed start line (inclusive)
   *   endLine   - 1-indexed end line (inclusive)
   *
   * Returns: { lines: Array<{ lineNumber: number; content: string }> }
   */
  router.get('/:id/context', async (req, res) => {
    try {
      const prId = Number(req.params.id);
      const filePath = req.query.filePath as string | undefined;
      const startLine = Number(req.query.startLine);
      const endLine = Number(req.query.endLine);

      if (!filePath || !Number.isFinite(startLine) || !Number.isFinite(endLine)) {
        res.status(400).json({ error: 'filePath, startLine, and endLine are required' });
        return;
      }
      if (startLine < 1 || endLine < startLine) {
        res
          .status(400)
          .json({ error: 'Invalid line range: startLine must be >= 1 and endLine >= startLine' });
        return;
      }

      const pr = prService.getPr(prId);
      if (!pr) {
        res.status(404).json({ error: 'PR not found' });
        return;
      }

      const git = new GitService({ repoPath });
      const localBranch = `pr-${pr.number}`;

      // Ensure the branch is available locally
      const branchExists = await git.refExists(localBranch);
      if (!branchExists) {
        await git.fetchPr(pr.number);
      }

      const fileContent = await git.getFileContent(localBranch, filePath);
      const allLines = fileContent.split('\n');

      // Clamp range to actual file length
      const clampedStart = Math.max(1, startLine);
      const clampedEnd = Math.min(allLines.length, endLine);

      const lines: Array<{ lineNumber: number; content: string }> = [];
      for (let i = clampedStart; i <= clampedEnd; i++) {
        lines.push({ lineNumber: i, content: allLines[i - 1] });
      }

      res.json({ lines });
    } catch (error) {
      const message = errorMessage(error);
      // git show fails if the file doesn't exist at that revision
      if (message.includes('does not exist') || message.includes('exists on disk')) {
        res.status(404).json({ error: `File not found at PR revision: ${req.query.filePath}` });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/prs/:id/prompt
   * Generate a self-contained tagging prompt for manual LLM analysis.
   * The user downloads this as a .txt file and pastes it into VS Code Copilot Chat.
   */
  router.get('/:id/prompt', async (req, res) => {
    try {
      const prId = Number(req.params.id);
      const pr = prService.getPr(prId);
      if (!pr) {
        res.status(404).json({ error: 'PR not found' });
        return;
      }

      // Get the diff from local git (same logic as analyze endpoint)
      const git = new GitService({ repoPath });
      const localBranch = `pr-${pr.number}`;
      const baseRef = `origin/${pr.baseRef}`;

      const branchExists = await git.refExists(localBranch);
      if (!branchExists) {
        await git.fetchPr(pr.number);
      }

      const rawDiff = await git.diff(baseRef, localBranch);
      const fileDiffs = parseDiff(rawDiff);
      const commitMessages = await git.getCommitLog(baseRef, localBranch);

      const prompt = buildExportablePrompt(
        pr.title,
        pr.body,
        pr.author,
        pr.baseRef,
        pr.headRef,
        commitMessages,
        fileDiffs,
      );

      const filename = `pr-${pr.number}-tagging-prompt.txt`;
      const result: PromptDownloadResponse = { prompt, filename };
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  /**
   * POST /api/prs/:id/import-analysis
   * Import manually-generated LLM analysis results.
   * Accepts the raw JSON output from VS Code Copilot Chat and processes it
   * through the same pipeline as the automated analysis.
   */
  router.post('/:id/import-analysis', (req, res) => {
    try {
      const prId = Number(req.params.id);
      const pr = prService.getPr(prId);
      if (!pr) {
        res.status(404).json({ error: 'PR not found' });
        return;
      }

      const body = req.body as ImportAnalysisRequest;

      // Validate structure
      if (!Array.isArray(body.tags) || !Array.isArray(body.chunk_assignments)) {
        res.status(400).json({
          error: 'Invalid format: expected { tags: [...], chunk_assignments: [...] }',
        });
        return;
      }

      for (const tag of body.tags) {
        if (typeof tag.name !== 'string' || typeof tag.description !== 'string') {
          res.status(400).json({
            error: 'Invalid tag: each tag must have "name" (string) and "description" (string)',
          });
          return;
        }
      }

      for (const assignment of body.chunk_assignments) {
        if (
          typeof assignment.file_path !== 'string' ||
          typeof assignment.chunk_index !== 'number' ||
          !Array.isArray(assignment.tags) ||
          typeof assignment.priority !== 'string'
        ) {
          res.status(400).json({
            error:
              'Invalid chunk_assignment: each must have "file_path" (string), "chunk_index" (number), "tags" (string[]), "priority" (string), and "review_note" (string|null)',
          });
          return;
        }
      }

      // Record the LLM run as a manual import
      const run = db
        .prepare("INSERT INTO llm_runs (pr_id, status) VALUES (?, 'completed') RETURNING id")
        .get(prId) as { id: number };

      db.prepare("UPDATE llm_runs SET finished_at = datetime('now') WHERE id = ?").run(run.id);

      // Map snake_case → camelCase and validate priorities
      const mapped = mapTaggingResult(body);

      // Store chunk metadata and tags (same pipeline as automated analysis)
      storeChunkMetadata(db, prId, run.id, mapped.chunkAssignments, mapped.tags);

      console.log(
        `[prs] Manual import for PR #${prId}: ${mapped.chunkAssignments.length} chunks tagged, ${mapped.tags.length} tags defined`,
      );

      res.json({
        tags: mapped.tags,
        chunkAssignments: mapped.chunkAssignments,
        tagSummaries: [],
      });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  return router;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
