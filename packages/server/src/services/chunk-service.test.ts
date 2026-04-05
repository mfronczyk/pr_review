import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../db/schema.js';
import { ChunkService } from './chunk-service.js';

describe('ChunkService', () => {
  let db: Database.Database;
  let service: ChunkService;
  let prId: number;

  beforeEach(() => {
    db = initDatabase(':memory:');
    service = new ChunkService({ db });

    // Insert a PR
    db.prepare(
      "INSERT INTO prs (owner, repo, number, gh_host) VALUES ('psf', 'requests', 7272, 'github.com')",
    ).run();
    prId = (db.prepare('SELECT id FROM prs LIMIT 1').get() as { id: number }).id;

    // Insert some chunks
    const insertChunk = db.prepare(
      `INSERT INTO chunks (pr_id, file_path, chunk_index, content_hash, diff_text, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertChunk.run(prId, 'src/utils.py', 0, 'hash_a', '+import typing', 10, 16);
    insertChunk.run(prId, 'src/utils.py', 1, 'hash_b', '-old\n+new', 45, 52);
    insertChunk.run(prId, 'src/models.py', 0, 'hash_c', '+class Model:', 1, 20);
  });

  describe('getChunksForPr', () => {
    it('should return all chunks for a PR', () => {
      const chunks = service.getChunksForPr(prId);
      expect(chunks).toHaveLength(3);
    });

    it('should order by file_path then chunk_index', () => {
      const chunks = service.getChunksForPr(prId);
      expect(chunks[0].filePath).toBe('src/models.py');
      expect(chunks[1].filePath).toBe('src/utils.py');
      expect(chunks[1].chunkIndex).toBe(0);
      expect(chunks[2].chunkIndex).toBe(1);
    });

    it('should include tags, metadata, and comments', () => {
      const chunks = service.getChunksForPr(prId);
      expect(chunks[0].tags).toEqual([]);
      expect(chunks[0].metadata).toBeNull();
      expect(chunks[0].comments).toEqual([]);
    });
  });

  describe('toggleApproved', () => {
    it('should toggle from unapproved to approved', () => {
      const chunks = service.getChunksForPr(prId);
      const result = service.toggleApproved(chunks[0].id);
      expect(result.approved).toBe(true);
      expect(result.approvedAt).not.toBeNull();
    });

    it('should toggle back to unapproved', () => {
      const chunks = service.getChunksForPr(prId);
      service.toggleApproved(chunks[0].id);
      const result = service.toggleApproved(chunks[0].id);
      expect(result.approved).toBe(false);
      expect(result.approvedAt).toBeNull();
    });

    it('should throw for nonexistent chunk', () => {
      expect(() => service.toggleApproved(999)).toThrow('Chunk not found');
    });
  });

  describe('bulkApproveByTag', () => {
    it('should mark all chunks with a tag as approved', () => {
      const chunks = service.getChunksForPr(prId);
      const tags = service.getAllTags();
      const refactorTag = tags.find((t) => t.name === 'refactor');
      if (!refactorTag) throw new Error('refactor tag not found');

      // Tag two chunks with 'refactor'
      service.addTagsToChunk(chunks[0].id, [refactorTag.id]);
      service.addTagsToChunk(chunks[1].id, [refactorTag.id]);

      const count = service.bulkApproveByTag(prId, refactorTag.id);
      expect(count).toBe(2);

      // Verify
      const updated = service.getChunksForPr(prId);
      expect(updated[0].approved).toBe(true);
      expect(updated[1].approved).toBe(true);
      expect(updated[2].approved).toBe(false);
    });
  });

  describe('tag operations', () => {
    it('should get all default tags', () => {
      const tags = service.getAllTags();
      expect(tags.length).toBeGreaterThanOrEqual(10);
      expect(tags.some((t) => t.name === 'bug-fix')).toBe(true);
    });

    it('should add tags to a chunk', () => {
      const chunks = service.getChunksForPr(prId);
      const tags = service.getAllTags();
      service.addTagsToChunk(chunks[0].id, [tags[0].id, tags[1].id]);

      const updated = service.getChunk(chunks[0].id);
      expect(updated?.tags).toHaveLength(2);
    });

    it('should not duplicate tags', () => {
      const chunks = service.getChunksForPr(prId);
      const tags = service.getAllTags();
      service.addTagsToChunk(chunks[0].id, [tags[0].id]);
      service.addTagsToChunk(chunks[0].id, [tags[0].id]);

      const updated = service.getChunk(chunks[0].id);
      expect(updated?.tags).toHaveLength(1);
    });

    it('should remove a tag from a chunk', () => {
      const chunks = service.getChunksForPr(prId);
      const tags = service.getAllTags();
      service.addTagsToChunk(chunks[0].id, [tags[0].id, tags[1].id]);
      service.removeTagFromChunk(chunks[0].id, tags[0].id);

      const updated = service.getChunk(chunks[0].id);
      expect(updated?.tags).toHaveLength(1);
      expect(updated?.tags[0].id).toBe(tags[1].id);
    });

    it('should replace all tags on a chunk', () => {
      const chunks = service.getChunksForPr(prId);
      const tags = service.getAllTags();
      service.addTagsToChunk(chunks[0].id, [tags[0].id, tags[1].id]);
      service.setChunkTags(chunks[0].id, [tags[2].id]);

      const updated = service.getChunk(chunks[0].id);
      expect(updated?.tags).toHaveLength(1);
      expect(updated?.tags[0].id).toBe(tags[2].id);
    });
  });

  describe('metadata', () => {
    it('should create metadata for a chunk', () => {
      const chunks = service.getChunksForPr(prId);
      service.updateMetadata(chunks[0].id, 'high', 'Check this carefully');

      const updated = service.getChunk(chunks[0].id);
      expect(updated?.metadata?.priority).toBe('high');
      expect(updated?.metadata?.reviewNote).toBe('Check this carefully');
    });

    it('should update existing metadata', () => {
      const chunks = service.getChunksForPr(prId);
      service.updateMetadata(chunks[0].id, 'high', 'Note 1');
      service.updateMetadata(chunks[0].id, 'low', 'Note 2');

      const updated = service.getChunk(chunks[0].id);
      expect(updated?.metadata?.priority).toBe('low');
      expect(updated?.metadata?.reviewNote).toBe('Note 2');
    });

    it('should preserve fields when partially updating', () => {
      const chunks = service.getChunksForPr(prId);
      service.updateMetadata(chunks[0].id, 'high', 'Important note');
      service.updateMetadata(chunks[0].id, 'low');

      const updated = service.getChunk(chunks[0].id);
      expect(updated?.metadata?.priority).toBe('low');
      expect(updated?.metadata?.reviewNote).toBe('Important note');
    });
  });
});
