/**
 * Unit tests for PrService.reconcileChunks – verifies chunk reconciliation
 * preserves approval state, tags, metadata, and comments for unchanged chunks
 * while correctly adding/removing changed chunks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initDatabase } from '../db/schema.js';
import { PrService } from './pr-service.js';

interface ChunkInput {
  filePath: string;
  chunkIndex: number;
  contentHash: string;
  diffText: string;
  startLine: number;
  endLine: number;
}

let db: Database.Database;
let service: PrService;
let dbPath: string;
const prId = 1;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `pr-review-reconcile-test-${Date.now()}.db`);
  db = initDatabase(dbPath);
  service = new PrService({ db, repoPath: '/tmp/fake-repo' });

  // Seed a PR row
  db.prepare(`
    INSERT INTO prs (id, owner, repo, number, title, author, state, base_ref, head_ref, head_sha, body, gh_host)
    VALUES (1, 'test', 'repo', 1, 'Test PR', 'tester', 'open', 'main', 'feature', 'abc123', 'body', 'github.com')
  `).run();
});

beforeEach(() => {
  // Clear chunks + cascade data before each test
  db.prepare('DELETE FROM chunks WHERE pr_id = ?').run(prId);
});

afterAll(() => {
  db.close();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // cleanup best-effort
  }
});

function getChunks(): Array<{
  id: number;
  content_hash: string;
  file_path: string;
  chunk_index: number;
  approved: number;
  start_line: number;
  end_line: number;
}> {
  return db
    .prepare('SELECT * FROM chunks WHERE pr_id = ? ORDER BY file_path, chunk_index')
    .all(prId) as Array<{
    id: number;
    content_hash: string;
    file_path: string;
    chunk_index: number;
    approved: number;
    start_line: number;
    end_line: number;
  }>;
}

function getTags(chunkId: number): Array<{ tag_id: number }> {
  return db.prepare('SELECT * FROM chunk_tags WHERE chunk_id = ?').all(chunkId) as Array<{
    tag_id: number;
  }>;
}

function getComments(chunkId: number): Array<{ id: number; body: string }> {
  return db.prepare('SELECT * FROM comments WHERE chunk_id = ?').all(chunkId) as Array<{
    id: number;
    body: string;
  }>;
}

function getMetadata(
  chunkId: number,
): { priority: string; review_note: string | null } | undefined {
  return db.prepare('SELECT * FROM chunk_metadata WHERE chunk_id = ?').get(chunkId) as
    | { priority: string; review_note: string | null }
    | undefined;
}

const chunkA: ChunkInput = {
  filePath: 'src/a.ts',
  chunkIndex: 0,
  contentHash: 'hashA',
  diffText: '+added line',
  startLine: 1,
  endLine: 5,
};

const chunkB: ChunkInput = {
  filePath: 'src/b.ts',
  chunkIndex: 0,
  contentHash: 'hashB',
  diffText: '-removed line',
  startLine: 10,
  endLine: 15,
};

describe('PrService.reconcileChunks', () => {
  it('should insert all chunks on first sync', () => {
    const result = service.reconcileChunks(prId, [chunkA, chunkB]);
    expect(result).toEqual({ added: 2, removed: 0, updated: 0, outdated: 0 });

    const chunks = getChunks();
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content_hash).toBe('hashA');
    expect(chunks[1].content_hash).toBe('hashB');
    expect(chunks[0].approved).toBe(0);
  });

  it('should preserve approval state for unchanged chunks', () => {
    // Initial sync
    service.reconcileChunks(prId, [chunkA, chunkB]);
    const chunks = getChunks();
    // Mark chunk A as approved
    db.prepare("UPDATE chunks SET approved = 1, approved_at = datetime('now') WHERE id = ?").run(
      chunks[0].id,
    );

    // Sync again with same chunks
    const result = service.reconcileChunks(prId, [chunkA, chunkB]);
    expect(result).toEqual({ added: 0, removed: 0, updated: 0, outdated: 0 });

    const afterSync = getChunks();
    expect(afterSync[0].approved).toBe(1); // preserved
    expect(afterSync[0].id).toBe(chunks[0].id); // same row
  });

  it('should preserve tags, metadata, and comments for unchanged chunks', () => {
    service.reconcileChunks(prId, [chunkA]);
    const chunks = getChunks();
    const chunkId = chunks[0].id;

    // Add tag
    const tagId = (db.prepare('SELECT id FROM tags LIMIT 1').get() as { id: number }).id;
    db.prepare('INSERT INTO chunk_tags (chunk_id, tag_id) VALUES (?, ?)').run(chunkId, tagId);

    // Add metadata
    db.prepare('INSERT INTO chunk_metadata (chunk_id, priority, review_note) VALUES (?, ?, ?)').run(
      chunkId,
      'high',
      'Important',
    );

    // Add comment
    db.prepare('INSERT INTO comments (chunk_id, pr_id, body, line) VALUES (?, ?, ?, ?)').run(
      chunkId,
      prId,
      'Test comment',
      12,
    );

    // Sync again
    service.reconcileChunks(prId, [chunkA]);

    expect(getTags(chunkId)).toHaveLength(1);
    expect(getMetadata(chunkId)?.priority).toBe('high');
    expect(getComments(chunkId)).toHaveLength(1);
    expect(getComments(chunkId)[0].body).toBe('Test comment');
  });

  it('should delete chunks whose content hash is gone', () => {
    service.reconcileChunks(prId, [chunkA, chunkB]);
    const chunks = getChunks();
    expect(chunks).toHaveLength(2);

    // Sync with only chunkA — chunkB is removed
    const result = service.reconcileChunks(prId, [chunkA]);
    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);

    const afterSync = getChunks();
    expect(afterSync).toHaveLength(1);
    expect(afterSync[0].content_hash).toBe('hashA');
  });

  it('should cascade-delete tags, metadata, comments when chunk is removed', () => {
    service.reconcileChunks(prId, [chunkA]);
    const chunks = getChunks();
    const chunkId = chunks[0].id;

    // Add associated data
    const tagId = (db.prepare('SELECT id FROM tags LIMIT 1').get() as { id: number }).id;
    db.prepare('INSERT INTO chunk_tags (chunk_id, tag_id) VALUES (?, ?)').run(chunkId, tagId);
    db.prepare('INSERT INTO chunk_metadata (chunk_id, priority) VALUES (?, ?)').run(
      chunkId,
      'high',
    );
    db.prepare('INSERT INTO comments (chunk_id, pr_id, body, line) VALUES (?, ?, ?, ?)').run(
      chunkId,
      prId,
      'will be deleted',
      10,
    );

    // Sync with empty — removes chunkA
    service.reconcileChunks(prId, []);
    expect(getTags(chunkId)).toHaveLength(0);
    expect(getMetadata(chunkId)).toBeUndefined();
    expect(getComments(chunkId)).toHaveLength(0);
  });

  it('should add new chunks when content hash is new', () => {
    service.reconcileChunks(prId, [chunkA]);

    const chunkC: ChunkInput = {
      filePath: 'src/c.ts',
      chunkIndex: 0,
      contentHash: 'hashC',
      diffText: '+brand new',
      startLine: 1,
      endLine: 3,
    };

    const result = service.reconcileChunks(prId, [chunkA, chunkC]);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);

    const chunks = getChunks();
    expect(chunks).toHaveLength(2);
    // New chunk should be unapproved
    const newChunk = chunks.find((c) => c.content_hash === 'hashC');
    expect(newChunk).toBeDefined();
    expect(newChunk?.approved).toBe(0);
  });

  it('should handle content change at same position: old deleted, new inserted', () => {
    service.reconcileChunks(prId, [chunkA]);
    const chunks = getChunks();
    db.prepare("UPDATE chunks SET approved = 1, approved_at = datetime('now') WHERE id = ?").run(
      chunks[0].id,
    );

    // Same position, different content hash
    const chunkAModified: ChunkInput = {
      filePath: 'src/a.ts',
      chunkIndex: 0,
      contentHash: 'hashA_v2',
      diffText: '+modified line',
      startLine: 1,
      endLine: 5,
    };

    const result = service.reconcileChunks(prId, [chunkAModified]);
    expect(result.removed).toBe(1); // old hashA removed
    expect(result.added).toBe(1); // new hashA_v2 added

    const afterSync = getChunks();
    expect(afterSync).toHaveLength(1);
    expect(afterSync[0].content_hash).toBe('hashA_v2');
    expect(afterSync[0].approved).toBe(0); // fresh, not approved
  });

  it('should update position when chunk moves but content stays the same', () => {
    service.reconcileChunks(prId, [chunkA]);
    const chunks = getChunks();
    const originalId = chunks[0].id;
    db.prepare("UPDATE chunks SET approved = 1, approved_at = datetime('now') WHERE id = ?").run(
      originalId,
    );

    // Same hash, different position
    const chunkAMoved: ChunkInput = {
      ...chunkA,
      filePath: 'src/moved.ts',
      chunkIndex: 2,
      startLine: 20,
      endLine: 25,
    };

    const result = service.reconcileChunks(prId, [chunkAMoved]);
    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);

    const afterSync = getChunks();
    expect(afterSync).toHaveLength(1);
    expect(afterSync[0].id).toBe(originalId); // same DB row
    expect(afterSync[0].approved).toBe(1); // approval preserved
    expect(afterSync[0].file_path).toBe('src/moved.ts');
    expect(afterSync[0].chunk_index).toBe(2);
    expect(afterSync[0].start_line).toBe(20);
  });

  it('should handle mix of added, removed, preserved, and moved chunks', () => {
    service.reconcileChunks(prId, [chunkA, chunkB]);
    const chunks = getChunks();
    // Review both
    for (const c of chunks) {
      db.prepare("UPDATE chunks SET approved = 1, approved_at = datetime('now') WHERE id = ?").run(
        c.id,
      );
    }
    const idA = chunks.find((c) => c.content_hash === 'hashA')?.id;
    const idB = chunks.find((c) => c.content_hash === 'hashB')?.id;

    // chunkA stays, chunkB removed, chunkC added
    const chunkC: ChunkInput = {
      filePath: 'src/c.ts',
      chunkIndex: 0,
      contentHash: 'hashC',
      diffText: '+new chunk',
      startLine: 1,
      endLine: 3,
    };

    const result = service.reconcileChunks(prId, [chunkA, chunkC]);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.updated).toBe(0);

    const afterSync = getChunks();
    expect(afterSync).toHaveLength(2);

    const survivorA = afterSync.find((c) => c.content_hash === 'hashA');
    expect(survivorA?.id).toBe(idA);
    expect(survivorA?.approved).toBe(1);

    const newC = afterSync.find((c) => c.content_hash === 'hashC');
    expect(newC?.approved).toBe(0);

    // Confirm B is gone
    const bExists = db.prepare('SELECT id FROM chunks WHERE id = ?').get(idB);
    expect(bExists).toBeUndefined();
  });
});
