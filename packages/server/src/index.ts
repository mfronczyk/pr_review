import path from 'node:path';
import type Database from 'better-sqlite3';
import express from 'express';
import { initDatabase } from './db/schema.js';
import { createChunkRoutes } from './routes/chunks.js';
import { createCommentRoutes } from './routes/comments.js';
import { createPrRoutes } from './routes/prs.js';

const PORT = Number.parseInt(process.env.PORT ?? '3420', 10);
const REPO_PATH = process.env.REPO_PATH ?? process.cwd();

/**
 * Create and configure the Express app.
 * Exported separately so tests can create an app with a custom DB.
 */
export function createApp(db: Database.Database, repoPath: string): express.Express {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

// Initialize and start server when run directly
if (process.env.NODE_ENV !== 'test') {
  const db: Database.Database = initDatabase();
  const app = createApp(db, REPO_PATH);

  app.listen(PORT, () => {
    console.log(`PR Review server running at http://localhost:${PORT}`);
    console.log(`Repo path: ${REPO_PATH}`);
  });
}
