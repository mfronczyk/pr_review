import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ServerConfig } from '@pr-review/shared';
import express from 'express';
import { initDatabase } from './db/schema.js';
import { createChunkRoutes } from './routes/chunks.js';
import { createCommentRoutes } from './routes/comments.js';
import { createPrRoutes } from './routes/prs.js';

const PORT = Number.parseInt(process.env.PORT ?? '3420', 10);
const REPO_PATH = (process.env.REPO_PATH ?? process.cwd()).trim();

/**
 * Create and configure the Express app.
 * Exported separately so tests can create an app with a custom DB.
 */
export function createApp(db: DatabaseSync, repoPath: string): express.Express {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Server configuration
  app.get('/api/config', (_req, res) => {
    const config: ServerConfig = { repoPath };
    res.json(config);
  });

  // API routes
  app.use('/api/prs', createPrRoutes(db, repoPath));
  app.use('/api', createChunkRoutes(db));
  app.use('/api', createCommentRoutes(db));

  // Serve static client build in production
  if (process.env.NODE_ENV === 'production') {
    const clientDist = path.resolve(import.meta.dirname, '../../client/dist');
    app.use(express.static(clientDist));

    // SPA fallback
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}

/**
 * Validate that the given path is a git repository with an 'origin' remote.
 * Returns the remote URL on success, or calls process.exit(1) on failure.
 */
function validateRepoPath(repoPath: string): string {
  // 1. Check path exists and is a directory
  try {
    const stat = fs.statSync(repoPath);
    if (!stat.isDirectory()) {
      console.error('\nError: REPO_PATH is not a directory.\n');
      console.error(`  REPO_PATH: ${repoPath}\n`);
      console.error('Set REPO_PATH to a cloned git repository:');
      console.error('  REPO_PATH=/path/to/repo npm run dev\n');
      process.exit(1);
    }
  } catch {
    console.error('\nError: REPO_PATH does not exist.\n');
    console.error(`  REPO_PATH: ${repoPath}\n`);
    console.error('Set REPO_PATH to a cloned git repository:');
    console.error('  REPO_PATH=/path/to/repo npm run dev\n');
    process.exit(1);
  }

  // 2. Check it's a git repository
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch {
    console.error('\nError: REPO_PATH is not a git repository.\n');
    console.error(`  REPO_PATH: ${repoPath}\n`);
    console.error('Clone the repository first, then point REPO_PATH to it:');
    console.error('  git clone <repo-url> /path/to/repo');
    console.error('  REPO_PATH=/path/to/repo npm run dev\n');
    process.exit(1);
  }

  // 3. Check it has an 'origin' remote
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    return remoteUrl;
  } catch {
    console.error("\nError: Git repository has no 'origin' remote.\n");
    console.error(`  REPO_PATH: ${repoPath}\n`);
    console.error('Add an origin remote:');
    console.error(`  cd ${repoPath}`);
    console.error('  git remote add origin <repo-url>\n');
    process.exit(1);
  }
}

// Initialize and start server when run directly
if (process.env.NODE_ENV !== 'test') {
  const remoteUrl = validateRepoPath(REPO_PATH);

  const dbPath = path.join(REPO_PATH, '.pr-review', 'data.db');
  const db: DatabaseSync = initDatabase(dbPath);
  const app = createApp(db, REPO_PATH);

  app.listen(PORT, () => {
    console.log(`PR Review server running at http://localhost:${PORT}`);
    console.log(`Repo path: ${REPO_PATH}`);
    console.log(`Remote:    ${remoteUrl}`);
    console.log(`Database:  ${dbPath}`);
  });
}
