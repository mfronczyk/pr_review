/**
 * Unit tests for PrService – verifies chunk reconciliation
 * preserves approval state, tags, metadata, and comments for unchanged chunks
 * while correctly adding/removing changed chunks, and tests review submission.
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
  file_status: string;
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
    file_status: string;
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

    // Chunk has 2 tags: 'unassigned' (from first sync) + 'test-tag' (manually added)
    expect(getTags(chunkId)).toHaveLength(2);
    const tagNames = getTags(chunkId).map((ct) => {
      const t = db.prepare('SELECT name FROM tags WHERE id = ?').get(ct.tag_id) as { name: string };
      return t.name;
    });
    expect(tagNames).toContain('test-tag');
    expect(tagNames).toContain('unassigned');
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
    expect(after[0].id).toBe(before[0].id); // same row
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

    // Both chunks should have the 'unassigned' tag
    for (const chunk of chunks) {
      const tags = getTags(chunk.id);
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

    // Manually assign a real tag to chunkA (simulate LLM analysis)
    db.prepare('DELETE FROM chunk_tags WHERE chunk_id = ?').run(chunksAfterFirst[0].id);
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
    db.prepare('INSERT INTO chunk_tags (chunk_id, tag_id) VALUES (?, ?)').run(
      chunksAfterFirst[0].id,
      realTagId,
    );

    // Sync again adding chunkB
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
    const chunkARow = chunksAfterSecond.find((c) => c.content_hash === 'hashA');
    expect(chunkARow).toBeDefined();
    const chunkATags = getTags(chunkARow!.id);
    expect(chunkATags).toHaveLength(1);
    expect(chunkATags[0].tag_id).toBe(realTagId);

    // chunkC should have the 'unassigned' tag
    const chunkCRow = chunksAfterSecond.find((c) => c.content_hash === 'hashC');
    expect(chunkCRow).toBeDefined();
    const chunkCTags = getTags(chunkCRow!.id);
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

    const chunks = getChunks();
    const tags = getTags(chunks[0].id);
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
