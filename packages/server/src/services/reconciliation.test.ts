/**
 * Integration tests for the delete-and-recreate reconciliation strategy.
 *
 * These tests verify the core behavior that motivated the refactor:
 * approval state, tags, and metadata survive chunk recreation during sync,
 * because they're stored in separate tables keyed by (pr_id, content_hash).
 */

import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../db/schema.js';
import { ChunkService } from './chunk-service.js';
import { PrService } from './pr-service.js';

describe('Reconciliation – state survival across sync', () => {
  let db: Database.Database;
  let prService: PrService;
  let chunkService: ChunkService;
  let prId: number;

  beforeEach(() => {
    db = initDatabase(':memory:');
    prService = new PrService({ db, repoPath: '/tmp/fake-repo' });
    chunkService = new ChunkService({ db });

    db.prepare(
      "INSERT INTO prs (owner, repo, number, gh_host) VALUES ('org', 'repo', 1, 'github.com')",
    ).run();
    prId = (db.prepare('SELECT id FROM prs LIMIT 1').get() as { id: number }).id;
  });

  describe('approval survival', () => {
    it('should preserve approval when chunk is recreated with same hash', () => {
      const chunk = {
        filePath: 'src/utils.ts',
        chunkIndex: 0,
        contentHash: 'hash_stable',
        diffText: '+import { foo } from "bar"',
        startLine: 1,
        endLine: 5,
      };

      // First sync + approve
      prService.reconcileChunks(prId, [chunk]);
      const chunks1 = chunkService.getChunksForPr(prId);
      chunkService.toggleApproved(chunks1[0].id);
      expect(chunkService.getChunk(chunks1[0].id)?.approved).toBe(true);

      // Second sync — chunk is deleted and recreated
      prService.reconcileChunks(prId, [chunk]);
      const chunks2 = chunkService.getChunksForPr(prId);
      // New chunk ID, but approval persists via content hash
      expect(chunks2[0].id).not.toBe(chunks1[0].id);
      expect(chunks2[0].approved).toBe(true);
      expect(chunks2[0].approvedAt).not.toBeNull();
    });

    it('should lose approval when chunk content actually changes', () => {
      const chunkV1 = {
        filePath: 'src/utils.ts',
        chunkIndex: 0,
        contentHash: 'hash_v1',
        diffText: '+original code',
        startLine: 1,
        endLine: 5,
      };

      prService.reconcileChunks(prId, [chunkV1]);
      const chunks1 = chunkService.getChunksForPr(prId);
      chunkService.toggleApproved(chunks1[0].id);

      const chunkV2 = {
        filePath: 'src/utils.ts',
        chunkIndex: 0,
        contentHash: 'hash_v2', // different hash = different content
        diffText: '+modified code',
        startLine: 1,
        endLine: 5,
      };

      prService.reconcileChunks(prId, [chunkV2]);
      const chunks2 = chunkService.getChunksForPr(prId);
      // New hash → no approval record
      expect(chunks2[0].approved).toBe(false);
      expect(chunks2[0].approvedAt).toBeNull();
    });

    it('should preserve approval when line numbers shift (same hash)', () => {
      const chunkOriginal = {
        filePath: 'src/utils.ts',
        chunkIndex: 0,
        contentHash: 'hash_stable',
        diffText: '@@ -10,5 +10,5 @@\n+import { foo } from "bar"',
        startLine: 10,
        endLine: 15,
      };

      prService.reconcileChunks(prId, [chunkOriginal]);
      const chunks1 = chunkService.getChunksForPr(prId);
      chunkService.toggleApproved(chunks1[0].id);

      // Same hash, but line numbers shifted (common after upstream changes)
      const chunkShifted = {
        ...chunkOriginal,
        diffText: '@@ -25,5 +25,5 @@\n+import { foo } from "bar"',
        startLine: 25,
        endLine: 30,
      };

      prService.reconcileChunks(prId, [chunkShifted]);
      const chunks2 = chunkService.getChunksForPr(prId);
      expect(chunks2[0].approved).toBe(true);
      expect(chunks2[0].startLine).toBe(25); // position updated
    });
  });

  describe('tag survival', () => {
    it('should preserve tags when chunk is recreated with same hash', () => {
      const chunk = {
        filePath: 'src/api.ts',
        chunkIndex: 0,
        contentHash: 'hash_tagged',
        diffText: '+api endpoint',
        startLine: 1,
        endLine: 10,
      };

      prService.reconcileChunks(prId, [chunk]);
      const chunks1 = chunkService.getChunksForPr(prId);

      // Replace unassigned tag with a real tag
      db.prepare('INSERT INTO tags (pr_id, name, description) VALUES (?, ?, ?)').run(
        prId,
        'api-changes',
        'API changes',
      );
      const apiTag = db
        .prepare("SELECT id FROM tags WHERE name = 'api-changes' AND pr_id = ?")
        .get(prId) as { id: number };
      chunkService.setChunkTags(chunks1[0].id, [apiTag.id]);

      // Verify tag is set
      const beforeSync = chunkService.getChunk(chunks1[0].id);
      expect(beforeSync?.tags).toHaveLength(1);
      expect(beforeSync?.tags[0].name).toBe('api-changes');

      // Re-sync — chunk is deleted and recreated
      prService.reconcileChunks(prId, [chunk]);
      const chunks2 = chunkService.getChunksForPr(prId);

      // Tag survives because chunk_tags is keyed by (pr_id, content_hash)
      expect(chunks2[0].tags).toHaveLength(1);
      expect(chunks2[0].tags[0].name).toBe('api-changes');
    });

    it('should assign "unassigned" tag to new chunks but not overwrite existing tags', () => {
      const existingChunk = {
        filePath: 'src/old.ts',
        chunkIndex: 0,
        contentHash: 'hash_old',
        diffText: '+old code',
        startLine: 1,
        endLine: 5,
      };

      prService.reconcileChunks(prId, [existingChunk]);
      const chunks1 = chunkService.getChunksForPr(prId);

      // Replace unassigned tag
      db.prepare('INSERT INTO tags (pr_id, name, description) VALUES (?, ?, ?)').run(
        prId,
        'refactor',
        'Refactoring',
      );
      const refactorTag = db
        .prepare("SELECT id FROM tags WHERE name = 'refactor' AND pr_id = ?")
        .get(prId) as { id: number };
      chunkService.setChunkTags(chunks1[0].id, [refactorTag.id]);

      // Add a new chunk
      const newChunk = {
        filePath: 'src/new.ts',
        chunkIndex: 0,
        contentHash: 'hash_new',
        diffText: '+new code',
        startLine: 1,
        endLine: 5,
      };

      prService.reconcileChunks(prId, [existingChunk, newChunk]);
      const chunks2 = chunkService.getChunksForPr(prId);

      const oldChunk = chunks2.find((c) => c.contentHash === 'hash_old');
      const freshChunk = chunks2.find((c) => c.contentHash === 'hash_new');

      // Old chunk keeps its 'refactor' tag, not re-assigned 'unassigned'
      expect(oldChunk?.tags).toHaveLength(1);
      expect(oldChunk?.tags[0].name).toBe('refactor');

      // New chunk gets 'unassigned'
      expect(freshChunk?.tags).toHaveLength(1);
      expect(freshChunk?.tags[0].name).toBe('unassigned');
    });
  });

  describe('metadata survival', () => {
    it('should preserve metadata when chunk is recreated with same hash', () => {
      const chunk = {
        filePath: 'src/core.ts',
        chunkIndex: 0,
        contentHash: 'hash_meta',
        diffText: '+core logic',
        startLine: 1,
        endLine: 20,
      };

      prService.reconcileChunks(prId, [chunk]);
      const chunks1 = chunkService.getChunksForPr(prId);
      chunkService.updateMetadata(chunks1[0].id, 'high', 'Critical path — review carefully');

      // Verify metadata
      const before = chunkService.getChunk(chunks1[0].id);
      expect(before?.metadata?.priority).toBe('high');
      expect(before?.metadata?.reviewNote).toBe('Critical path — review carefully');

      // Re-sync
      prService.reconcileChunks(prId, [chunk]);
      const chunks2 = chunkService.getChunksForPr(prId);

      // Metadata survives
      expect(chunks2[0].metadata?.priority).toBe('high');
      expect(chunks2[0].metadata?.reviewNote).toBe('Critical path — review carefully');
    });
  });

  describe('comments behavior', () => {
    it('should drop unpublished comments on sync (they CASCADE with chunk rows)', () => {
      const chunk = {
        filePath: 'src/feature.ts',
        chunkIndex: 0,
        contentHash: 'hash_comments',
        diffText: '+feature code',
        startLine: 1,
        endLine: 10,
      };

      prService.reconcileChunks(prId, [chunk]);
      const chunks1 = chunkService.getChunksForPr(prId);

      // Add an unpublished comment
      db.prepare('INSERT INTO comments (chunk_id, pr_id, body, line) VALUES (?, ?, ?, ?)').run(
        chunks1[0].id,
        prId,
        'Draft comment',
        5,
      );

      const before = chunkService.getChunk(chunks1[0].id);
      expect(before?.comments).toHaveLength(1);

      // Re-sync — chunk rows are deleted and recreated
      prService.reconcileChunks(prId, [chunk]);
      const chunks2 = chunkService.getChunksForPr(prId);

      // Comments are gone (CASCADE delete)
      expect(chunks2[0].comments).toHaveLength(0);
    });
  });

  describe('bulk approve by tag across sync', () => {
    it('should bulk-approve chunks by tag, and approval survives sync', () => {
      const chunks = [
        {
          filePath: 'src/a.ts',
          chunkIndex: 0,
          contentHash: 'hash_a',
          diffText: '+a',
          startLine: 1,
          endLine: 5,
        },
        {
          filePath: 'src/b.ts',
          chunkIndex: 0,
          contentHash: 'hash_b',
          diffText: '+b',
          startLine: 1,
          endLine: 5,
        },
        {
          filePath: 'src/c.ts',
          chunkIndex: 0,
          contentHash: 'hash_c',
          diffText: '+c',
          startLine: 1,
          endLine: 5,
        },
      ];

      prService.reconcileChunks(prId, chunks);

      // Create a tag and assign to first two chunks
      db.prepare('INSERT INTO tags (pr_id, name, description) VALUES (?, ?, ?)').run(
        prId,
        'safe',
        'Safe changes',
      );
      const safeTag = db
        .prepare("SELECT id FROM tags WHERE name = 'safe' AND pr_id = ?")
        .get(prId) as { id: number };

      const chunkRows = chunkService.getChunksForPr(prId);
      chunkService.setChunkTags(chunkRows[0].id, [safeTag.id]);
      chunkService.setChunkTags(chunkRows[1].id, [safeTag.id]);

      // Bulk approve by 'safe' tag
      const count = chunkService.bulkApproveByTag(prId, safeTag.id);
      expect(count).toBe(2);

      // Verify approvals
      const before = chunkService.getChunksForPr(prId);
      expect(before.find((c) => c.contentHash === 'hash_a')?.approved).toBe(true);
      expect(before.find((c) => c.contentHash === 'hash_b')?.approved).toBe(true);
      expect(before.find((c) => c.contentHash === 'hash_c')?.approved).toBe(false);

      // Re-sync — all chunk rows recreated
      prService.reconcileChunks(prId, chunks);

      // Approvals survive
      const after = chunkService.getChunksForPr(prId);
      expect(after.find((c) => c.contentHash === 'hash_a')?.approved).toBe(true);
      expect(after.find((c) => c.contentHash === 'hash_b')?.approved).toBe(true);
      expect(after.find((c) => c.contentHash === 'hash_c')?.approved).toBe(false);
    });
  });

  describe('full lifecycle', () => {
    it('should handle approve → re-tag → sync → verify all state preserved', () => {
      const chunk = {
        filePath: 'src/lifecycle.ts',
        chunkIndex: 0,
        contentHash: 'hash_lifecycle',
        diffText: '+lifecycle code',
        startLine: 1,
        endLine: 10,
      };

      // 1. Initial sync
      prService.reconcileChunks(prId, [chunk]);
      let current = chunkService.getChunksForPr(prId);
      expect(current[0].tags[0].name).toBe('unassigned');
      expect(current[0].approved).toBe(false);

      // 2. Approve
      chunkService.toggleApproved(current[0].id);

      // 3. Add metadata
      chunkService.updateMetadata(current[0].id, 'high', 'Critical');

      // 4. Re-tag (like LLM analysis would)
      db.prepare('INSERT INTO tags (pr_id, name, description) VALUES (?, ?, ?)').run(
        prId,
        'core-logic',
        'Core logic changes',
      );
      const coreTag = db
        .prepare("SELECT id FROM tags WHERE name = 'core-logic' AND pr_id = ?")
        .get(prId) as { id: number };
      chunkService.setChunkTags(current[0].id, [coreTag.id]);

      // 5. Verify full state before sync
      current = chunkService.getChunksForPr(prId);
      expect(current[0].approved).toBe(true);
      expect(current[0].metadata?.priority).toBe('high');
      expect(current[0].metadata?.reviewNote).toBe('Critical');
      expect(current[0].tags[0].name).toBe('core-logic');

      // 6. Sync again (simulating PR update with no content changes)
      prService.reconcileChunks(prId, [chunk]);

      // 7. Verify everything survived
      current = chunkService.getChunksForPr(prId);
      expect(current).toHaveLength(1);
      expect(current[0].approved).toBe(true);
      expect(current[0].metadata?.priority).toBe('high');
      expect(current[0].metadata?.reviewNote).toBe('Critical');
      expect(current[0].tags).toHaveLength(1);
      expect(current[0].tags[0].name).toBe('core-logic');
    });
  });
});
