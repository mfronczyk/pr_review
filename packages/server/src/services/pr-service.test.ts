/**
 * Unit tests for PrService – verifies chunk reconciliation with
 * delete-and-recreate strategy. Approval state, tags, and metadata
 * are stored in separate tables keyed by (pr_id, content_hash),
 * so they survive chunk row recreation automatically.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initDatabase } from '../db/schema.js';
import { getOctokit } from './github-client.js';
import { PrService } from './pr-service.js';

vi.mock('./github-client.js', () => ({
  getOctokit: vi.fn(),
}));

interface ChunkInput {
  filePath: string;
  chunkIndex: number;
  contentHash: string;
  diffText: string;
  startLine: number;
  endLine: number;
  fileStatus?: string;
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
  // Clear hash-keyed tables too (these don't cascade with chunks)
  db.prepare('DELETE FROM chunk_reviews WHERE pr_id = ?').run(prId);
  db.prepare('DELETE FROM chunk_tags WHERE pr_id = ?').run(prId);
  db.prepare('DELETE FROM chunk_metadata WHERE pr_id = ?').run(prId);
  db.prepare('DELETE FROM tags WHERE pr_id = ?').run(prId);
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
  start_line: number;
  end_line: number;
  file_status: string;
}> {
  return db
    .prepare('SELECT * FROM chunks WHERE pr_id = ? ORDER BY file_path, chunk_index')
    .all(prId) as Array<{
    id: number;
    content_hash: string;
    file_path: string;
    chunk_index: number;
    start_line: number;
    end_line: number;
    file_status: string;
  }>;
}

function getReview(
  contentHash: string,
): { approved: number; approved_at: string | null } | undefined {
  return db
    .prepare('SELECT * FROM chunk_reviews WHERE pr_id = ? AND content_hash = ?')
    .get(prId, contentHash) as { approved: number; approved_at: string | null } | undefined;
}

function getTags(contentHash: string): Array<{ tag_id: number }> {
  return db
    .prepare('SELECT * FROM chunk_tags WHERE pr_id = ? AND content_hash = ?')
    .all(prId, contentHash) as Array<{ tag_id: number }>;
}

function getComments(chunkId: number): Array<{ id: number; body: string }> {
  return db.prepare('SELECT * FROM comments WHERE chunk_id = ?').all(chunkId) as Array<{
    id: number;
    body: string;
  }>;
}

function getMetadata(
  contentHash: string,
): { priority: string; review_note: string | null } | undefined {
  return db
    .prepare('SELECT * FROM chunk_metadata WHERE pr_id = ? AND content_hash = ?')
    .get(prId, contentHash) as { priority: string; review_note: string | null } | undefined;
}

/**
 * Helper to approve a chunk by its content hash (via chunk_reviews table).
 */
function approveHash(contentHash: string): void {
  db.prepare(
    `INSERT INTO chunk_reviews (pr_id, content_hash, approved, approved_at)
     VALUES (?, ?, 1, datetime('now'))
     ON CONFLICT (pr_id, content_hash) DO UPDATE SET approved = 1, approved_at = datetime('now')`,
  ).run(prId, contentHash);
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
    expect(result).toEqual({ added: 2, removed: 0 });

    const chunks = getChunks();
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content_hash).toBe('hashA');
    expect(chunks[1].content_hash).toBe('hashB');
    // No review record yet — chunks start unapproved
    expect(getReview('hashA')).toBeUndefined();
  });

  it('should preserve approval state for unchanged chunks', () => {
    // Initial sync
    service.reconcileChunks(prId, [chunkA, chunkB]);
    // Mark chunk A as approved via chunk_reviews
    approveHash('hashA');

    // Sync again with same chunks
    const result = service.reconcileChunks(prId, [chunkA, chunkB]);
    expect(result).toEqual({ added: 0, removed: 0 });

    // Approval survives because it's stored in chunk_reviews keyed by (pr_id, content_hash)
    const review = getReview('hashA');
    expect(review?.approved).toBe(1);
  });

  it('should preserve tags, metadata for unchanged chunks (comments are dropped)', () => {
    service.reconcileChunks(prId, [chunkA]);
    const chunks = getChunks();
    const chunkId = chunks[0].id;
    const contentHash = chunks[0].content_hash;

    // Add tag (hash-keyed)
    db.prepare('INSERT INTO tags (pr_id, name, description) VALUES (?, ?, ?)').run(
      prId,
      'test-tag',
      'Test tag',
    );
    const tagId = (
      db.prepare('SELECT id FROM tags WHERE name = ? AND pr_id = ?').get('test-tag', prId) as {
        id: number;
      }
    ).id;
    db.prepare('INSERT INTO chunk_tags (pr_id, content_hash, tag_id) VALUES (?, ?, ?)').run(
      prId,
      contentHash,
      tagId,
    );

    // Add metadata (hash-keyed)
    db.prepare(
      'INSERT INTO chunk_metadata (pr_id, content_hash, priority, review_note) VALUES (?, ?, ?, ?)',
    ).run(prId, contentHash, 'high', 'Important');

    // Add comment (chunk_id-keyed — will be dropped on sync)
    db.prepare('INSERT INTO comments (chunk_id, pr_id, body, line) VALUES (?, ?, ?, ?)').run(
      chunkId,
      prId,
      'Test comment',
      12,
    );

    // Sync again
    service.reconcileChunks(prId, [chunkA]);

    // Tags survive (hash-keyed): 'unassigned' (from first sync) + 'test-tag' (manually added)
    const tags = getTags(contentHash);
    expect(tags).toHaveLength(2);
    const tagNames = tags.map((ct) => {
      const t = db.prepare('SELECT name FROM tags WHERE id = ?').get(ct.tag_id) as { name: string };
      return t.name;
    });
    expect(tagNames).toContain('test-tag');
    expect(tagNames).toContain('unassigned');

    // Metadata survives (hash-keyed)
    expect(getMetadata(contentHash)?.priority).toBe('high');

    // Comments are dropped — chunk rows are deleted and recreated, comments CASCADE with them
    const newChunks = getChunks();
    expect(getComments(newChunks[0].id)).toHaveLength(0);
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

  it('should clean up comments, tags, metadata, and reviews when chunk hash is removed', () => {
    service.reconcileChunks(prId, [chunkA]);
    const chunks = getChunks();
    const chunkId = chunks[0].id;
    const contentHash = chunks[0].content_hash;

    // Add associated data
    db.prepare('INSERT INTO tags (pr_id, name, description) VALUES (?, ?, ?)').run(
      prId,
      'cascade-tag',
      'Tag for cascade test',
    );
    const tagId = (
      db.prepare('SELECT id FROM tags WHERE name = ? AND pr_id = ?').get('cascade-tag', prId) as {
        id: number;
      }
    ).id;
    db.prepare('INSERT INTO chunk_tags (pr_id, content_hash, tag_id) VALUES (?, ?, ?)').run(
      prId,
      contentHash,
      tagId,
    );
    db.prepare('INSERT INTO chunk_metadata (pr_id, content_hash, priority) VALUES (?, ?, ?)').run(
      prId,
      contentHash,
      'high',
    );
    approveHash(contentHash);
    db.prepare('INSERT INTO comments (chunk_id, pr_id, body, line) VALUES (?, ?, ?, ?)').run(
      chunkId,
      prId,
      'will be deleted',
      10,
    );

    // Sync with empty — removes chunkA
    service.reconcileChunks(prId, []);

    // Comments cascade-delete with chunk rows
    expect(getComments(chunkId)).toHaveLength(0);

    // Tags, metadata, and reviews are cleaned up by orphan cleanup
    expect(getTags(contentHash)).toHaveLength(0);
    expect(getMetadata(contentHash)).toBeUndefined();
    expect(getReview(contentHash)).toBeUndefined();
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
    // New chunk should have no review record (unapproved)
    const newChunk = chunks.find((c) => c.content_hash === 'hashC');
    expect(newChunk).toBeDefined();
    expect(getReview('hashC')).toBeUndefined();
  });

  it('should handle content change at same position: old deleted, new inserted', () => {
    service.reconcileChunks(prId, [chunkA]);
    approveHash('hashA');

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
    // New hash has no review record — not approved
    expect(getReview('hashA_v2')).toBeUndefined();
    // Old hash's approval is cleaned up by orphan cleanup
    expect(getReview('hashA')).toBeUndefined();
  });

  it('should recreate chunks with new positions when content stays the same', () => {
    service.reconcileChunks(prId, [chunkA]);
    approveHash('hashA');

    // Same hash, different position
    const chunkAMoved: ChunkInput = {
      ...chunkA,
      filePath: 'src/moved.ts',
      chunkIndex: 2,
      startLine: 20,
      endLine: 25,
    };

    const result = service.reconcileChunks(prId, [chunkAMoved]);
    // Delete-and-recreate: hash is same so added=0, removed=0
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);

    const afterSync = getChunks();
    expect(afterSync).toHaveLength(1);
    // Approval survives (hash-keyed)
    expect(getReview('hashA')?.approved).toBe(1);
    // New position is reflected in the recreated row
    expect(afterSync[0].file_path).toBe('src/moved.ts');
    expect(afterSync[0].chunk_index).toBe(2);
    expect(afterSync[0].start_line).toBe(20);
  });

  it('should handle mix of added, removed, and preserved chunks', () => {
    service.reconcileChunks(prId, [chunkA, chunkB]);
    approveHash('hashA');
    approveHash('hashB');

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

    const afterSync = getChunks();
    expect(afterSync).toHaveLength(2);

    // hashA's approval survives
    expect(getReview('hashA')?.approved).toBe(1);

    // hashC has no approval
    expect(getReview('hashC')).toBeUndefined();

    // Confirm B is gone from chunks table
    const bExists = db
      .prepare('SELECT id FROM chunks WHERE pr_id = ? AND content_hash = ?')
      .get(prId, 'hashB');
    expect(bExists).toBeUndefined();
  });

  it('should update diff_text when line numbers shift but hash is the same', () => {
    service.reconcileChunks(prId, [chunkA]);
    approveHash('hashA');

    // Same hash, updated diff text (simulates line number shift in @@ header)
    const chunkAShifted: ChunkInput = {
      ...chunkA,
      diffText: '+added line (shifted)',
      startLine: 20,
      endLine: 25,
    };

    const result = service.reconcileChunks(prId, [chunkAShifted]);
    // added=0, removed=0 because hash is the same
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);

    const afterSync = getChunks();
    // Approval preserved (hash-keyed)
    expect(getReview('hashA')?.approved).toBe(1);
    // diff_text is updated via recreated row
    const row = db.prepare('SELECT diff_text FROM chunks WHERE id = ?').get(afterSync[0].id) as {
      diff_text: string;
    };
    expect(row.diff_text).toBe('+added line (shifted)');
  });
});

describe('PrService.reconcileChunks – duplicate hashes', () => {
  it('should handle two chunks with the same hash in initial sync', () => {
    const dup1: ChunkInput = {
      filePath: 'src/a.ts',
      chunkIndex: 0,
      contentHash: 'hashDup',
      diffText: '+import os',
      startLine: 1,
      endLine: 1,
    };
    const dup2: ChunkInput = {
      filePath: 'src/b.ts',
      chunkIndex: 0,
      contentHash: 'hashDup',
      diffText: '+import os',
      startLine: 1,
      endLine: 1,
    };

    const result = service.reconcileChunks(prId, [dup1, dup2]);
    // Hash set comparison: only 1 unique hash is "added"
    expect(result.added).toBe(1);

    const chunks = getChunks();
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content_hash).toBe('hashDup');
    expect(chunks[1].content_hash).toBe('hashDup');
  });

  it('should preserve approval for duplicate-hash chunks on re-sync', () => {
    const dup1: ChunkInput = {
      filePath: 'src/a.ts',
      chunkIndex: 0,
      contentHash: 'hashDup',
      diffText: '+import os',
      startLine: 1,
      endLine: 1,
    };
    const dup2: ChunkInput = {
      filePath: 'src/b.ts',
      chunkIndex: 0,
      contentHash: 'hashDup',
      diffText: '+import os',
      startLine: 1,
      endLine: 1,
    };

    service.reconcileChunks(prId, [dup1, dup2]);
    // Approve the hash (shared by both chunks)
    approveHash('hashDup');

    // Re-sync with same chunks
    const result = service.reconcileChunks(prId, [dup1, dup2]);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);

    const afterSync = getChunks();
    expect(afterSync).toHaveLength(2);
    // Both share the same hash, so both are approved via chunk_reviews
    expect(getReview('hashDup')?.approved).toBe(1);
  });

  it('should delete excess duplicates when count decreases', () => {
    const dup1: ChunkInput = {
      filePath: 'src/a.ts',
      chunkIndex: 0,
      contentHash: 'hashDup',
      diffText: '+import os',
      startLine: 1,
      endLine: 1,
    };
    const dup2: ChunkInput = {
      filePath: 'src/b.ts',
      chunkIndex: 0,
      contentHash: 'hashDup',
      diffText: '+import os',
      startLine: 1,
      endLine: 1,
    };

    service.reconcileChunks(prId, [dup1, dup2]);
    approveHash('hashDup');

    // Re-sync with only one occurrence
    const result = service.reconcileChunks(prId, [dup1]);
    // Hash is still present, so added=0, removed=0 (hash set comparison)
    expect(result.removed).toBe(0);
    expect(result.added).toBe(0);

    const afterSync = getChunks();
    expect(afterSync).toHaveLength(1);
    // Approval survives (hash-keyed)
    expect(getReview('hashDup')?.approved).toBe(1);
  });

  it('should add new duplicate when count increases', () => {
    const dup1: ChunkInput = {
      filePath: 'src/a.ts',
      chunkIndex: 0,
      contentHash: 'hashDup',
      diffText: '+import os',
      startLine: 1,
      endLine: 1,
    };

    service.reconcileChunks(prId, [dup1]);
    approveHash('hashDup');

    // Re-sync with two occurrences of the same hash
    const dup2: ChunkInput = {
      filePath: 'src/b.ts',
      chunkIndex: 0,
      contentHash: 'hashDup',
      diffText: '+import os',
      startLine: 1,
      endLine: 1,
    };

    const result = service.reconcileChunks(prId, [dup1, dup2]);
    // Hash already existed, so added=0, removed=0
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);

    const afterSync = getChunks();
    expect(afterSync).toHaveLength(2);
    // Both share the same approval (hash-keyed)
    expect(getReview('hashDup')?.approved).toBe(1);
  });

  it('should handle all duplicates being removed', () => {
    const dup1: ChunkInput = {
      filePath: 'src/a.ts',
      chunkIndex: 0,
      contentHash: 'hashDup',
      diffText: '+import os',
      startLine: 1,
      endLine: 1,
    };
    const dup2: ChunkInput = {
      filePath: 'src/b.ts',
      chunkIndex: 0,
      contentHash: 'hashDup',
      diffText: '+import os',
      startLine: 1,
      endLine: 1,
    };

    service.reconcileChunks(prId, [dup1, dup2]);
    expect(getChunks()).toHaveLength(2);

    // Re-sync with no chunks
    const result = service.reconcileChunks(prId, []);
    expect(result.removed).toBe(1); // one unique hash removed

    expect(getChunks()).toHaveLength(0);
  });
});

describe('PrService.reconcileChunks – file_status', () => {
  it('should store file_status when inserting new chunks', () => {
    const addedChunk: ChunkInput = {
      ...chunkA,
      fileStatus: 'added',
    };

    service.reconcileChunks(prId, [addedChunk]);
    const chunks = getChunks();
    expect(chunks).toHaveLength(1);
    expect(chunks[0].file_status).toBe('added');
  });

  it('should default file_status to modified when not provided', () => {
    service.reconcileChunks(prId, [chunkA]);
    const chunks = getChunks();
    expect(chunks).toHaveLength(1);
    expect(chunks[0].file_status).toBe('modified');
  });

  it('should update file_status when it changes on sync', () => {
    // First sync: chunk is 'modified'
    service.reconcileChunks(prId, [{ ...chunkA, fileStatus: 'modified' }]);
    const before = getChunks();
    expect(before[0].file_status).toBe('modified');

    // Second sync: same content but status changed to 'renamed'
    service.reconcileChunks(prId, [{ ...chunkA, fileStatus: 'renamed' }]);
    const after = getChunks();
    expect(after[0].file_status).toBe('renamed');
    // Chunk ID changes (delete-and-recreate), but that's expected
  });

  it('should store different statuses for different files', () => {
    const addedChunk: ChunkInput = { ...chunkA, fileStatus: 'added' };
    const deletedChunk: ChunkInput = { ...chunkB, fileStatus: 'deleted' };

    service.reconcileChunks(prId, [addedChunk, deletedChunk]);
    const chunks = getChunks();
    expect(chunks).toHaveLength(2);

    const chunkARow = chunks.find((c) => c.content_hash === 'hashA');
    const chunkBRow = chunks.find((c) => c.content_hash === 'hashB');
    expect(chunkARow?.file_status).toBe('added');
    expect(chunkBRow?.file_status).toBe('deleted');
  });
});

describe('PrService.reconcileChunks – unassigned tag', () => {
  it('should assign "unassigned" tag to new chunks on first sync', () => {
    service.reconcileChunks(prId, [chunkA, chunkB]);
    const chunks = getChunks();
    expect(chunks).toHaveLength(2);

    // Both chunks should have the 'unassigned' tag (via content_hash)
    for (const chunk of chunks) {
      const tags = getTags(chunk.content_hash);
      expect(tags).toHaveLength(1);

      const tagRow = db.prepare('SELECT * FROM tags WHERE id = ?').get(tags[0].tag_id) as {
        name: string;
        description: string;
      };
      expect(tagRow.name).toBe('unassigned');
      expect(tagRow.description).toBe('Chunks not categorized by LLM analysis');
    }
  });

  it('should assign "unassigned" tag to newly added chunks on subsequent sync', () => {
    // Initial sync with chunkA
    service.reconcileChunks(prId, [chunkA]);
    const chunksAfterFirst = getChunks();
    expect(chunksAfterFirst).toHaveLength(1);
    const contentHashA = chunksAfterFirst[0].content_hash;

    // Manually assign a real tag to chunkA (simulate LLM analysis)
    db.prepare('DELETE FROM chunk_tags WHERE pr_id = ? AND content_hash = ?').run(
      prId,
      contentHashA,
    );
    db.prepare('INSERT INTO tags (pr_id, name, description) VALUES (?, ?, ?)').run(
      prId,
      'real-tag',
      'A real tag',
    );
    const realTagId = (
      db.prepare('SELECT id FROM tags WHERE name = ? AND pr_id = ?').get('real-tag', prId) as {
        id: number;
      }
    ).id;
    db.prepare('INSERT INTO chunk_tags (pr_id, content_hash, tag_id) VALUES (?, ?, ?)').run(
      prId,
      contentHashA,
      realTagId,
    );

    // Sync again adding chunkC
    const chunkC: ChunkInput = {
      filePath: 'src/c.ts',
      chunkIndex: 0,
      contentHash: 'hashC',
      diffText: '+new stuff',
      startLine: 1,
      endLine: 4,
    };
    service.reconcileChunks(prId, [chunkA, chunkC]);

    const chunksAfterSecond = getChunks();
    expect(chunksAfterSecond).toHaveLength(2);

    // chunkA should still have only its real tag (not unassigned)
    const chunkATags = getTags(contentHashA);
    expect(chunkATags).toHaveLength(1);
    expect(chunkATags[0].tag_id).toBe(realTagId);

    // chunkC should have the 'unassigned' tag
    const chunkCTags = getTags('hashC');
    expect(chunkCTags).toHaveLength(1);
    const unassignedTag = db
      .prepare('SELECT * FROM tags WHERE id = ?')
      .get(chunkCTags[0].tag_id) as {
      name: string;
    };
    expect(unassignedTag.name).toBe('unassigned');
  });

  it('should not duplicate "unassigned" tag when syncing with no new chunks', () => {
    // Initial sync
    service.reconcileChunks(prId, [chunkA]);

    // Sync again with same chunks — no new additions
    service.reconcileChunks(prId, [chunkA]);

    const tags = getTags('hashA');
    // Should still have exactly 1 unassigned tag, not 2
    expect(tags).toHaveLength(1);
  });
});

describe('PrService.submitReview', () => {
  it('should submit an APPROVE review', async () => {
    const mockCreateReview = vi.fn().mockResolvedValue({
      data: {
        id: 100,
        state: 'APPROVED',
        submitted_at: '2026-04-06T10:00:00Z',
      },
    });

    vi.mocked(getOctokit).mockResolvedValue({
      pulls: { createReview: mockCreateReview },
    } as never);

    const result = await service.submitReview(prId, 'APPROVE', 'Looks good!');

    expect(result).toEqual({
      id: 100,
      state: 'APPROVED',
      submittedAt: '2026-04-06T10:00:00Z',
    });

    expect(mockCreateReview).toHaveBeenCalledWith({
      owner: 'test',
      repo: 'repo',
      pull_number: 1,
      event: 'APPROVE',
      body: 'Looks good!',
    });
  });

  it('should submit a COMMENT review without body', async () => {
    const mockCreateReview = vi.fn().mockResolvedValue({
      data: {
        id: 101,
        state: 'COMMENTED',
        submitted_at: '2026-04-06T11:00:00Z',
      },
    });

    vi.mocked(getOctokit).mockResolvedValue({
      pulls: { createReview: mockCreateReview },
    } as never);

    const result = await service.submitReview(prId, 'COMMENT');

    expect(result).toEqual({
      id: 101,
      state: 'COMMENTED',
      submittedAt: '2026-04-06T11:00:00Z',
    });

    expect(mockCreateReview).toHaveBeenCalledWith({
      owner: 'test',
      repo: 'repo',
      pull_number: 1,
      event: 'COMMENT',
      body: undefined,
    });
  });

  it('should throw for non-existent PR', async () => {
    await expect(service.submitReview(999, 'APPROVE')).rejects.toThrow('PR not found: 999');
  });
});
