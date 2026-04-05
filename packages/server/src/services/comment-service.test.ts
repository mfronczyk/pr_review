import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../db/schema.js';
import { CommentService } from './comment-service.js';

describe('CommentService', () => {
  let db: Database.Database;
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
    it('should create a comment', () => {
      const comment = service.createComment(chunkId, prId, 'This looks wrong');
      expect(comment.id).toBeDefined();
      expect(comment.body).toBe('This looks wrong');
      expect(comment.chunkId).toBe(chunkId);
      expect(comment.prId).toBe(prId);
      expect(comment.ghCommentId).toBeNull();
      expect(comment.publishedAt).toBeNull();
    });
  });

  describe('updateComment', () => {
    it('should update comment body', () => {
      const comment = service.createComment(chunkId, prId, 'Original');
      const updated = service.updateComment(comment.id, 'Updated text');
      expect(updated.body).toBe('Updated text');
    });

    it('should throw for nonexistent comment', () => {
      expect(() => service.updateComment(999, 'text')).toThrow('Comment not found');
    });
  });

  describe('deleteComment', () => {
    it('should delete an unpublished comment', () => {
      const comment = service.createComment(chunkId, prId, 'To delete');
      const result = service.deleteComment(comment.id);
      expect(result).toBe(true);

      const comments = service.getCommentsForPr(prId);
      expect(comments).toHaveLength(0);
    });

    it('should return false for nonexistent comment', () => {
      expect(service.deleteComment(999)).toBe(false);
    });

    it('should throw when deleting a published comment', () => {
      const comment = service.createComment(chunkId, prId, 'Published');
      // Simulate publishing
      db.prepare(
        "UPDATE comments SET gh_comment_id = 12345, published_at = datetime('now') WHERE id = ?",
      ).run(comment.id);

      expect(() => service.deleteComment(comment.id)).toThrow('Cannot delete a published comment');
    });
  });

  describe('getCommentsForPr', () => {
    it('should return all comments for a PR', () => {
      service.createComment(chunkId, prId, 'Comment 1');
      service.createComment(chunkId, prId, 'Comment 2');

      const comments = service.getCommentsForPr(prId);
      expect(comments).toHaveLength(2);
    });

    it('should order by created_at', () => {
      service.createComment(chunkId, prId, 'First');
      service.createComment(chunkId, prId, 'Second');

      const comments = service.getCommentsForPr(prId);
      expect(comments[0].body).toBe('First');
      expect(comments[1].body).toBe('Second');
    });
  });
});
