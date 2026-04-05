import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_DIR = path.join(os.homedir(), '.pr-review');
const DB_PATH = path.join(DB_DIR, 'data.db');

/**
 * Initialize the SQLite database with all required tables.
 * Uses WAL mode for better concurrent read performance.
 */
export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? DB_PATH;

  // Ensure directory exists (skip for in-memory DBs)
  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables(db);
  seedDefaultTags(db);

  return db;
}

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      owner         TEXT NOT NULL,
      repo          TEXT NOT NULL,
      number        INTEGER NOT NULL,
      title         TEXT NOT NULL DEFAULT '',
      author        TEXT NOT NULL DEFAULT '',
      state         TEXT NOT NULL DEFAULT 'open',
      base_ref      TEXT NOT NULL DEFAULT '',
      head_ref      TEXT NOT NULL DEFAULT '',
      head_sha      TEXT NOT NULL DEFAULT '',
      body          TEXT NOT NULL DEFAULT '',
      gh_host       TEXT NOT NULL DEFAULT 'github.com',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner, repo, number, gh_host)
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id         INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      file_path     TEXT NOT NULL,
      chunk_index   INTEGER NOT NULL,
      content_hash  TEXT NOT NULL,
      diff_text     TEXT NOT NULL,
      start_line    INTEGER NOT NULL DEFAULT 0,
      end_line      INTEGER NOT NULL DEFAULT 0,
      reviewed      INTEGER NOT NULL DEFAULT 0,
      reviewed_at   TEXT,
      UNIQUE(pr_id, file_path, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,
      description   TEXT NOT NULL DEFAULT '',
      color         TEXT NOT NULL DEFAULT '#6b7280',
      is_default    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chunk_tags (
      chunk_id      INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (chunk_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS chunk_metadata (
      chunk_id      INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      priority      TEXT NOT NULL DEFAULT 'medium',
      review_note   TEXT,
      llm_run_id    INTEGER REFERENCES llm_runs(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id      INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      pr_id         INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      body          TEXT NOT NULL,
      gh_comment_id INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      published_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS llm_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id         INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at   TEXT,
      status        TEXT NOT NULL DEFAULT 'running',
      summary       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_pr_id ON chunks(pr_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
    CREATE INDEX IF NOT EXISTS idx_chunk_tags_chunk_id ON chunk_tags(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_chunk_tags_tag_id ON chunk_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_comments_chunk_id ON comments(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_comments_pr_id ON comments(pr_id);
    CREATE INDEX IF NOT EXISTS idx_llm_runs_pr_id ON llm_runs(pr_id);
  `);
}

const DEFAULT_TAGS: Array<{ name: string; description: string; color: string }> = [
  { name: 'bug-fix', description: 'Fixes a bug or defect', color: '#ef4444' },
  { name: 'refactor', description: 'Code restructuring without behavior change', color: '#8b5cf6' },
  { name: 'new-feature', description: 'Adds new functionality', color: '#22c55e' },
  {
    name: 'style/formatting',
    description: 'Code style or formatting changes',
    color: '#f59e0b',
  },
  { name: 'tests', description: 'Test additions or modifications', color: '#06b6d4' },
  { name: 'docs', description: 'Documentation changes', color: '#3b82f6' },
  { name: 'config', description: 'Configuration or build changes', color: '#64748b' },
  { name: 'security', description: 'Security-related changes', color: '#dc2626' },
  { name: 'performance', description: 'Performance improvements', color: '#f97316' },
  {
    name: 'needs-discussion',
    description: 'Requires team discussion or review',
    color: '#ec4899',
  },
];

function seedDefaultTags(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO tags (name, description, color, is_default)
    VALUES (@name, @description, @color, 1)
  `);

  const insertMany = db.transaction((tags: typeof DEFAULT_TAGS) => {
    for (const tag of tags) {
      insert.run(tag);
    }
  });

  insertMany(DEFAULT_TAGS);
}
