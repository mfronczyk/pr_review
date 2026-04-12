/**
 * Integration tests for API routes.
 * Uses supertest with an in-memory SQLite database.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { initDatabase } from '../db/schema.js';
import { createApp } from '../index.js';
import { getOctokit } from '../services/github-client.js';

vi.mock('../services/github-client.js', () => ({
  getOctokit: vi.fn(),
}));

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

describe('GET /api/config', () => {
  it('should return server configuration with repoPath', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repoPath: '/tmp/test-repo' });
  });
});

describe('GET /api/llm/model', () => {
  it('should return 503 when no model info is available', async () => {
    const res = await request(app).get('/api/llm/model');
    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty('error');
  });

  it('should return model info when provided at creation', async () => {
    const appWithModel = createApp(db, '/tmp/test-repo', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    const res = await request(appWithModel).get('/api/llm/model');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
  });
});

describe('GET /api/prs/:prId/tags', () => {
  it('should return empty array when no tags exist for PR', async () => {
    const res = await request(app).get('/api/prs/1/tags');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('should return tags created for a PR', async () => {
    // Create tags for PR 1
    db.prepare('INSERT INTO tags (pr_id, name, description) VALUES (?, ?, ?)').run(
      1,
      'api-changes',
      'API endpoint changes',
    );
    db.prepare('INSERT INTO tags (pr_id, name, description) VALUES (?, ?, ?)').run(
      1,
      'validation',
      'Input validation',
    );

    const res = await request(app).get('/api/prs/1/tags');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toHaveProperty('name');
    expect(res.body[0]).toHaveProperty('prId');
    expect(res.body[0]).not.toHaveProperty('color');
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

  it('PATCH /api/chunks/:id/approved should toggle approved', async () => {
    const res = await request(app).patch('/api/chunks/1/approved');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('approved', true);

    // Toggle back
    const res2 = await request(app).patch('/api/chunks/1/approved');
    expect(res2.status).toBe(200);
    expect(res2.body).toHaveProperty('approved', false);
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
    // Tags should already exist from the previous test block
    const tagsRes = await request(app).get('/api/prs/1/tags');
    const apiTag = tagsRes.body.find((t: { name: string }) => t.name === 'api-changes');
    const valTag = tagsRes.body.find((t: { name: string }) => t.name === 'validation');

    const res = await request(app)
      .put('/api/chunks/1/tags')
      .send({ tagIds: [apiTag.id, valTag.id] });
    expect(res.status).toBe(200);
    expect(res.body.tags.length).toBe(2);
    expect(res.body.tags.map((t: { name: string }) => t.name).sort()).toEqual([
      'api-changes',
      'validation',
    ]);
  });

  it('PUT /api/chunks/:id/tags should reject non-array', async () => {
    const res = await request(app).put('/api/chunks/1/tags').send({ tagIds: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  it('POST /api/prs/:prId/bulk-approve should approve chunks by tag', async () => {
    // Tag chunk 2 as well
    const tagsRes = await request(app).get('/api/prs/1/tags');
    const valTag = tagsRes.body.find((t: { name: string }) => t.name === 'validation');
    await request(app)
      .put('/api/chunks/2/tags')
      .send({ tagIds: [valTag.id] });

    const res = await request(app).post('/api/prs/1/bulk-approve').send({ tagId: valTag.id });
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
    expect(res.body).toHaveProperty('side', 'RIGHT');
    expect(res.body).toHaveProperty('parentId', null);
    expect(res.body).toHaveProperty('author', null);
    expect(res.body).toHaveProperty('resolved', false);
    commentId = res.body.id;
  });

  it('POST /api/comments should create a LEFT-side comment', async () => {
    const res = await request(app)
      .post('/api/comments')
      .send({ chunkId: 1, prId: 1, body: 'Deleted line comment', line: 5, side: 'LEFT' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('side', 'LEFT');
    expect(res.body).toHaveProperty('line', 5);
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

describe('Tag summary routes', () => {
  it('GET /api/prs/:id/tag-summaries should return empty array when no summaries exist', async () => {
    const res = await request(app).get('/api/prs/1/tag-summaries');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it('GET /api/prs/:id/tag-summaries should return stored summaries', async () => {
    // Insert an LLM run first
    const run = db
      .prepare("INSERT INTO llm_runs (pr_id, status) VALUES (1, 'completed') RETURNING id")
      .get() as { id: number };

    // Create a tag for this PR (may already exist from earlier tests, so use INSERT OR IGNORE)
    db.prepare(
      "INSERT OR IGNORE INTO tags (pr_id, name, description) VALUES (1, 'input-validation-fix', 'Fixes input validation bugs')",
    ).run();
    const tag = db
      .prepare("SELECT id FROM tags WHERE name = 'input-validation-fix' AND pr_id = 1")
      .get() as { id: number };

    // Insert a tag summary
    db.prepare(
      'INSERT INTO tag_summaries (pr_id, tag_id, summary, llm_run_id) VALUES (?, ?, ?, ?)',
    ).run(1, tag.id, 'This group fixes input validation bugs in the registration flow.', run.id);

    const res = await request(app).get('/api/prs/1/tag-summaries');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual({
      tagId: tag.id,
      tagName: 'input-validation-fix',
      summary: 'This group fixes input validation bugs in the registration flow.',
    });

    // Cleanup
    db.prepare('DELETE FROM tag_summaries WHERE pr_id = 1').run();
    db.prepare(`DELETE FROM llm_runs WHERE id = ${run.id}`).run();
  });

  it('GET /api/prs/:id/tag-summaries should return empty for non-existent PR', async () => {
    const res = await request(app).get('/api/prs/999/tag-summaries');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('Submit review routes', () => {
  it('POST /api/prs/:id/submit-review should return 400 for invalid event', async () => {
    const res = await request(app)
      .post('/api/prs/1/submit-review')
      .send({ event: 'REQUEST_CHANGES' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('POST /api/prs/:id/submit-review should return 400 for missing event', async () => {
    const res = await request(app).post('/api/prs/1/submit-review').send({ body: 'some body' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('POST /api/prs/:id/submit-review should return 404 for non-existent PR', async () => {
    const res = await request(app).post('/api/prs/999/submit-review').send({ event: 'APPROVE' });
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('POST /api/prs/:id/submit-review should submit APPROVE review', async () => {
    const mockCreateReview = vi.fn().mockResolvedValue({
      data: {
        id: 200,
        state: 'APPROVED',
        submitted_at: '2026-04-06T12:00:00Z',
      },
    });

    vi.mocked(getOctokit).mockResolvedValue({
      pulls: { createReview: mockCreateReview },
    } as never);

    const res = await request(app)
      .post('/api/prs/1/submit-review')
      .send({ event: 'APPROVE', body: 'LGTM' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 200,
      state: 'APPROVED',
      submittedAt: '2026-04-06T12:00:00Z',
    });
  });

  it('POST /api/prs/:id/submit-review should submit COMMENT review', async () => {
    const mockCreateReview = vi.fn().mockResolvedValue({
      data: {
        id: 201,
        state: 'COMMENTED',
        submitted_at: '2026-04-06T12:00:00Z',
      },
    });

    vi.mocked(getOctokit).mockResolvedValue({
      pulls: { createReview: mockCreateReview },
    } as never);

    const res = await request(app).post('/api/prs/1/submit-review').send({ event: 'COMMENT' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 201,
      state: 'COMMENTED',
      submittedAt: '2026-04-06T12:00:00Z',
    });
  });
});
