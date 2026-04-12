import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../db/schema.js';
import { CommentService } from './comment-service.js';

describe('CommentService', () => {
  let db: DatabaseSync;
  let service: CommentService;
  let prId: number;
  let chunkId: number;

  beforeEach(() => {
    db = initDatabase(':memory:');
    service = new CommentService({ db });

    // Insert a PR
    db.prepare(
      "INSERT INTO prs (owner, repo, number, gh_host) VALUES ('psf', 'requests', 7272, 'github.com')",
    ).run();
    prId = (db.prepare('SELECT id FROM prs LIMIT 1').get() as { id: number }).id;

    // Insert a chunk
    db.prepare(
      `INSERT INTO chunks (pr_id, file_path, chunk_index, content_hash, diff_text, start_line, end_line)
       VALUES (?, 'src/utils.py', 0, 'hash_a', '+import typing', 10, 16)`,
    ).run(prId);
    chunkId = (db.prepare('SELECT id FROM chunks LIMIT 1').get() as { id: number }).id;
  });

  describe('createComment', () => {
    it('should create a root comment with a line number', () => {
      const comment = service.createComment(chunkId, prId, 'This looks wrong', 12);
      expect(comment.id).toBeDefined();
      expect(comment.body).toBe('This looks wrong');
      expect(comment.chunkId).toBe(chunkId);
      expect(comment.prId).toBe(prId);
      expect(comment.line).toBe(12);
      expect(comment.side).toBe('RIGHT');
      expect(comment.parentId).toBeNull();
      expect(comment.author).toBeNull();
      expect(comment.ghCommentId).toBeNull();
      expect(comment.resolved).toBe(false);
      expect(comment.publishedAt).toBeNull();
    });

    it('should create a comment on the LEFT side for deleted lines', () => {
      const comment = service.createComment(chunkId, prId, 'Old line comment', 8, 'LEFT');
      expect(comment.line).toBe(8);
      expect(comment.side).toBe('LEFT');
    });

    it('should create a reply to a root comment', () => {
      const root = service.createComment(chunkId, prId, 'Root comment', 12);
      const reply = service.createComment(chunkId, prId, 'Reply text', 12, 'RIGHT', root.id);
      expect(reply.parentId).toBe(root.id);
      expect(reply.line).toBe(12);
    });

    it('should reject reply to a reply (only root comments can have replies)', () => {
      const root = service.createComment(chunkId, prId, 'Root', 12);
      const reply = service.createComment(chunkId, prId, 'Reply', 12, 'RIGHT', root.id);
      expect(() => service.createComment(chunkId, prId, 'Nested', 12, 'RIGHT', reply.id)).toThrow(
        'Cannot reply to a reply',
      );
    });

    it('should reject reply to nonexistent parent', () => {
      expect(() => service.createComment(chunkId, prId, 'Reply', 12, 'RIGHT', 999)).toThrow(
        'Parent comment not found',
      );
    });

    it('should reject reply to a parent in a different chunk', () => {
      // Insert a second chunk
      db.prepare(
        `INSERT INTO chunks (pr_id, file_path, chunk_index, content_hash, diff_text, start_line, end_line)
         VALUES (?, 'src/other.py', 0, 'hash_b', '+import os', 1, 5)`,
      ).run(prId);
      const chunk2Id = (
        db.prepare("SELECT id FROM chunks WHERE content_hash = 'hash_b'").get() as { id: number }
      ).id;

      const root = service.createComment(chunkId, prId, 'Root', 12);
      expect(() =>
        service.createComment(chunk2Id, prId, 'Cross-chunk reply', 3, 'RIGHT', root.id),
      ).toThrow('Reply must belong to the same chunk');
    });
  });

  describe('updateComment', () => {
    it('should update comment body', () => {
      const comment = service.createComment(chunkId, prId, 'Original', 12);
      const updated = service.updateComment(comment.id, 'Updated text');
      expect(updated.body).toBe('Updated text');
    });

    it('should throw for nonexistent comment', () => {
      expect(() => service.updateComment(999, 'text')).toThrow('Comment not found');
    });
  });

  describe('deleteComment', () => {
    it('should delete an unpublished comment', () => {
      const comment = service.createComment(chunkId, prId, 'To delete', 12);
      const result = service.deleteComment(comment.id);
      expect(result).toBe(true);

      const comments = service.getCommentsForPr(prId);
      expect(comments).toHaveLength(0);
    });

    it('should cascade-delete replies when root is deleted', () => {
      const root = service.createComment(chunkId, prId, 'Root', 12);
      service.createComment(chunkId, prId, 'Reply 1', 12, 'RIGHT', root.id);
      service.createComment(chunkId, prId, 'Reply 2', 12, 'RIGHT', root.id);

      expect(service.getCommentsForPr(prId)).toHaveLength(3);
      service.deleteComment(root.id);
      expect(service.getCommentsForPr(prId)).toHaveLength(0);
    });

    it('should return false for nonexistent comment', () => {
      expect(service.deleteComment(999)).toBe(false);
    });

    it('should throw when deleting a published comment', () => {
      const comment = service.createComment(chunkId, prId, 'Published', 12);
      // Simulate publishing
      db.prepare(
        "UPDATE comments SET gh_comment_id = 12345, published_at = datetime('now') WHERE id = ?",
      ).run(comment.id);

      expect(() => service.deleteComment(comment.id)).toThrow('Cannot delete a published comment');
    });
  });

  describe('getCommentsForPr', () => {
    it('should return all comments for a PR', () => {
      service.createComment(chunkId, prId, 'Comment 1', 12);
      service.createComment(chunkId, prId, 'Comment 2', 14);

      const comments = service.getCommentsForPr(prId);
      expect(comments).toHaveLength(2);
    });

    it('should order by created_at', () => {
      service.createComment(chunkId, prId, 'First', 12);
      service.createComment(chunkId, prId, 'Second', 14);

      const comments = service.getCommentsForPr(prId);
      expect(comments[0].body).toBe('First');
      expect(comments[1].body).toBe('Second');
    });
  });

  describe('resolveThread', () => {
    it('should resolve a root comment', async () => {
      const root = service.createComment(chunkId, prId, 'Root', 12);
      expect(root.resolved).toBe(false);

      const resolved = await service.resolveThread(root.id);
      expect(resolved.resolved).toBe(true);
    });

    it('should throw when resolving a reply', async () => {
      const root = service.createComment(chunkId, prId, 'Root', 12);
      const reply = service.createComment(chunkId, prId, 'Reply', 12, 'RIGHT', root.id);
      await expect(() => service.resolveThread(reply.id)).rejects.toThrow(
        'Can only resolve root comments',
      );
    });

    it('should throw for nonexistent comment', async () => {
      await expect(() => service.resolveThread(999)).rejects.toThrow('Comment not found');
    });
  });

  describe('unresolveThread', () => {
    it('should unresolve a resolved thread', async () => {
      const root = service.createComment(chunkId, prId, 'Root', 12);
      await service.resolveThread(root.id);

      const unresolved = await service.unresolveThread(root.id);
      expect(unresolved.resolved).toBe(false);
    });

    it('should throw when unresolving a reply', async () => {
      const root = service.createComment(chunkId, prId, 'Root', 12);
      const reply = service.createComment(chunkId, prId, 'Reply', 12, 'RIGHT', root.id);
      await expect(() => service.unresolveThread(reply.id)).rejects.toThrow(
        'Can only unresolve root comments',
      );
    });
  });
});
