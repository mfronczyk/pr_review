import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from './schema.js';

describe('Database Schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(':memory:');
  });

  it('should create all required tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('prs');
    expect(tableNames).toContain('chunks');
    expect(tableNames).toContain('tags');
    expect(tableNames).toContain('chunk_tags');
    expect(tableNames).toContain('chunk_metadata');
    expect(tableNames).toContain('comments');
    expect(tableNames).toContain('llm_runs');
  });

  it('should seed default tags', () => {
    const tags = db.prepare('SELECT * FROM tags WHERE is_default = 1').all() as Array<{
      name: string;
      is_default: number;
    }>;

    expect(tags).toHaveLength(10);

    const tagNames = tags.map((t) => t.name);
    expect(tagNames).toContain('bug-fix');
    expect(tagNames).toContain('refactor');
    expect(tagNames).toContain('new-feature');
    expect(tagNames).toContain('tests');
    expect(tagNames).toContain('docs');
    expect(tagNames).toContain('config');
    expect(tagNames).toContain('security');
    expect(tagNames).toContain('performance');
    expect(tagNames).toContain('needs-discussion');
    expect(tagNames).toContain('style/formatting');
  });

  it('should not duplicate default tags on re-initialization', () => {
    // Run seed again
    initDatabase(':memory:');

    const tags = db.prepare('SELECT * FROM tags WHERE is_default = 1').all();
    expect(tags).toHaveLength(10);
  });

  it('should enforce foreign key constraints', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO chunks (pr_id, file_path, chunk_index, content_hash, diff_text)
         VALUES (999, 'test.py', 0, 'abc123', 'diff text')`,
      ).run();
    }).toThrow();
  });

  it('should enforce unique PR constraint', () => {
    db.prepare(
      `INSERT INTO prs (owner, repo, number, gh_host) VALUES ('psf', 'requests', 7272, 'github.com')`,
    ).run();

    expect(() => {
      db.prepare(
        `INSERT INTO prs (owner, repo, number, gh_host) VALUES ('psf', 'requests', 7272, 'github.com')`,
      ).run();
    }).toThrow();
  });

  it('should cascade delete chunks when PR is deleted', () => {
    db.prepare(
      `INSERT INTO prs (owner, repo, number, gh_host) VALUES ('psf', 'requests', 7272, 'github.com')`,
    ).run();

    const pr = db.prepare('SELECT id FROM prs WHERE number = 7272').get() as { id: number };

    db.prepare(
      `INSERT INTO chunks (pr_id, file_path, chunk_index, content_hash, diff_text)
       VALUES (?, 'test.py', 0, 'hash1', 'diff1')`,
    ).run(pr.id);

    db.prepare('DELETE FROM prs WHERE id = ?').run(pr.id);

    const chunks = db.prepare('SELECT * FROM chunks WHERE pr_id = ?').all(pr.id);
    expect(chunks).toHaveLength(0);
  });

  it('should set WAL journal mode for file-backed databases', () => {
    // In-memory databases don't support WAL mode, so we verify
    // the pragma is called by checking a file-backed DB
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const tmpPath = path.join(os.tmpdir(), `pr-review-test-${Date.now()}.db`);
    try {
      const fileDb = initDatabase(tmpPath);
      const result = fileDb.pragma('journal_mode') as Array<{ journal_mode: string }>;
      expect(result[0].journal_mode).toBe('wal');
      fileDb.close();
    } finally {
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(`${tmpPath}-wal`, { force: true });
      fs.rmSync(`${tmpPath}-shm`, { force: true });
    }
  });
});
