/**
 * Integration tests for API routes.
 * Uses supertest with an in-memory SQLite database.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initDatabase } from '../db/schema.js';
import { createApp } from '../index.js';

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `pr-review-api-test-${Date.now()}.db`);
  db = initDatabase(dbPath);
  app = createApp(db, '/tmp/test-repo');

  // Seed a PR and chunks for testing
  db.prepare(`
    INSERT INTO prs (owner, repo, number, title, author, state, base_ref, head_ref, head_sha, body, gh_host)
    VALUES ('test', 'repo', 1, 'Test PR', 'tester', 'open', 'main', 'feature', 'abc123', 'body', 'github.com')
  `).run();

  db.prepare(`
    INSERT INTO chunks (pr_id, file_path, chunk_index, content_hash, diff_text, start_line, end_line)
    VALUES (1, 'src/index.ts', 0, 'hash1', '@@ -1,3 +1,5 @@\n context\n-old\n+new', 1, 5)
  `).run();

  db.prepare(`
    INSERT INTO chunks (pr_id, file_path, chunk_index, content_hash, diff_text, start_line, end_line)
    VALUES (1, 'src/utils.ts', 0, 'hash2', '@@ -10,3 +10,4 @@\n line\n+added', 10, 14)
  `).run();
});

afterAll(() => {
  db.close();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // cleanup best-effort
  }
});

describe('GET /api/health', () => {
  it('should return health status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('timestamp');
  });
});

describe('GET /api/tags', () => {
  it('should return default tags', async () => {
    const res = await request(app).get('/api/tags');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(10);
    expect(res.body[0]).toHaveProperty('name');
    expect(res.body[0]).toHaveProperty('color');
  });
});

describe('Chunk routes', () => {
  it('GET /api/prs/:prId/chunks should return chunks with details', async () => {
    const res = await request(app).get('/api/prs/1/chunks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    expect(res.body[0]).toHaveProperty('filePath', 'src/index.ts');
    expect(res.body[0]).toHaveProperty('tags');
    expect(res.body[0]).toHaveProperty('comments');
  });

  it('GET /api/chunks/:id should return a single chunk', async () => {
    const res = await request(app).get('/api/chunks/1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 1);
    expect(res.body).toHaveProperty('filePath', 'src/index.ts');
  });

  it('GET /api/chunks/:id should return 404 for missing chunk', async () => {
    const res = await request(app).get('/api/chunks/999');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Chunk not found');
  });

  it('PATCH /api/chunks/:id/reviewed should toggle reviewed', async () => {
    const res = await request(app).patch('/api/chunks/1/reviewed');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reviewed', true);

    // Toggle back
    const res2 = await request(app).patch('/api/chunks/1/reviewed');
    expect(res2.status).toBe(200);
    expect(res2.body).toHaveProperty('reviewed', false);
  });

  it('PATCH /api/chunks/:id/metadata should update metadata', async () => {
    const res = await request(app)
      .patch('/api/chunks/1/metadata')
      .send({ priority: 'high', reviewNote: 'Check this carefully' });
    expect(res.status).toBe(200);
    expect(res.body.metadata).toHaveProperty('priority', 'high');
    expect(res.body.metadata).toHaveProperty('reviewNote', 'Check this carefully');
  });

  it('PUT /api/chunks/:id/tags should replace tags', async () => {
    // Get tag IDs first
    const tagsRes = await request(app).get('/api/tags');
    const bugFixTag = tagsRes.body.find((t: { name: string }) => t.name === 'bug-fix');
    const refactorTag = tagsRes.body.find((t: { name: string }) => t.name === 'refactor');

    const res = await request(app)
      .put('/api/chunks/1/tags')
      .send({ tagIds: [bugFixTag.id, refactorTag.id] });
    expect(res.status).toBe(200);
    expect(res.body.tags.length).toBe(2);
    expect(res.body.tags.map((t: { name: string }) => t.name).sort()).toEqual([
      'bug-fix',
      'refactor',
    ]);
  });

  it('PUT /api/chunks/:id/tags should reject non-array', async () => {
    const res = await request(app).put('/api/chunks/1/tags').send({ tagIds: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  it('POST /api/prs/:prId/bulk-approve should approve chunks by tag', async () => {
    // Tag chunk 2 as well
    const tagsRes = await request(app).get('/api/tags');
    const refactorTag = tagsRes.body.find((t: { name: string }) => t.name === 'refactor');
    await request(app)
      .put('/api/chunks/2/tags')
      .send({ tagIds: [refactorTag.id] });

    const res = await request(app).post('/api/prs/1/bulk-approve').send({ tagId: refactorTag.id });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('approved');
    expect(res.body.approved).toBeGreaterThanOrEqual(1);
  });
});

describe('Comment routes', () => {
  let commentId: number;

  it('POST /api/comments should create a comment with line', async () => {
    const res = await request(app)
      .post('/api/comments')
      .send({ chunkId: 1, prId: 1, body: 'Test comment', line: 3 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('body', 'Test comment');
    expect(res.body).toHaveProperty('line', 3);
    expect(res.body).toHaveProperty('parentId', null);
    expect(res.body).toHaveProperty('author', null);
    expect(res.body).toHaveProperty('resolved', false);
    commentId = res.body.id;
  });

  it('POST /api/comments should create a reply', async () => {
    const res = await request(app)
      .post('/api/comments')
      .send({ chunkId: 1, prId: 1, body: 'Reply text', line: 3, parentId: commentId });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('parentId', commentId);
  });

  it('GET /api/prs/:prId/comments should return comments', async () => {
    const res = await request(app).get('/api/prs/1/comments');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  it('PATCH /api/comments/:id should update comment body', async () => {
    const res = await request(app)
      .patch(`/api/comments/${commentId}`)
      .send({ body: 'Updated comment' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('body', 'Updated comment');
  });

  it('PATCH /api/comments/:id should reject empty body', async () => {
    const res = await request(app).patch(`/api/comments/${commentId}`).send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/comments/:id/resolve should resolve a thread', async () => {
    const res = await request(app).post(`/api/comments/${commentId}/resolve`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('resolved', true);
  });

  it('POST /api/comments/:id/unresolve should unresolve a thread', async () => {
    const res = await request(app).post(`/api/comments/${commentId}/unresolve`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('resolved', false);
  });

  it('POST /api/comments/:id/resolve should return 404 for missing comment', async () => {
    const res = await request(app).post('/api/comments/999/resolve');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/comments/:id should delete unpublished comment', async () => {
    // Delete the reply first (it was created in second test above)
    const comments = await request(app).get('/api/prs/1/comments');
    const reply = comments.body.find((c: { parentId: number | null }) => c.parentId === commentId);
    if (reply) {
      await request(app).delete(`/api/comments/${reply.id}`);
    }
    const res = await request(app).delete(`/api/comments/${commentId}`);
    expect(res.status).toBe(204);
  });

  it('DELETE /api/comments/:id should return 404 for missing comment', async () => {
    const res = await request(app).delete('/api/comments/999');
    expect(res.status).toBe(404);
  });

  it('POST /api/comments should reject missing fields', async () => {
    const res = await request(app).post('/api/comments').send({ chunkId: 1 });
    expect(res.status).toBe(400);
  });

  it('POST /api/comments should reject missing line', async () => {
    const res = await request(app)
      .post('/api/comments')
      .send({ chunkId: 1, prId: 1, body: 'No line' });
    expect(res.status).toBe(400);
  });
});
