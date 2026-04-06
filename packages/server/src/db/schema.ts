import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Initialize the SQLite database with all required tables.
 * Uses WAL mode for better concurrent read performance.
 *
 * @param dbPath - Path to the SQLite database file (or ':memory:' for tests).
 *                 For production use, pass `<repoPath>/.pr-review/data.db`.
 */
export function initDatabase(dbPath: string): Database.Database {
  const resolvedPath = dbPath;

  // Ensure directory exists (skip for in-memory DBs)
  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables(db);
  runMigrations(db);

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
      approved      INTEGER NOT NULL DEFAULT 0,
      approved_at   TEXT,
      UNIQUE(pr_id, file_path, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id         INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      UNIQUE(name, pr_id)
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
      line          INTEGER NOT NULL,
      parent_id     INTEGER REFERENCES comments(id) ON DELETE CASCADE,
      author        TEXT,
      gh_comment_id INTEGER,
      gh_node_id    TEXT,
      resolved      INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS tag_summaries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id         INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      summary       TEXT NOT NULL,
      llm_run_id    INTEGER REFERENCES llm_runs(id) ON DELETE SET NULL,
      UNIQUE(pr_id, tag_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_pr_id ON chunks(pr_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
    CREATE INDEX IF NOT EXISTS idx_chunk_tags_chunk_id ON chunk_tags(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_chunk_tags_tag_id ON chunk_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_tags_pr_id ON tags(pr_id);
    CREATE INDEX IF NOT EXISTS idx_comments_chunk_id ON comments(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_comments_pr_id ON comments(pr_id);
    CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);
    CREATE INDEX IF NOT EXISTS idx_llm_runs_pr_id ON llm_runs(pr_id);
    CREATE INDEX IF NOT EXISTS idx_tag_summaries_pr_id ON tag_summaries(pr_id);
  `);
}

/**
 * Run schema migrations for existing databases.
 * Each migration checks whether the change has already been applied.
 */
function runMigrations(db: Database.Database): void {
  // Migration: add gh_node_id column to comments table
  const cols = db.pragma('table_info(comments)') as Array<{ name: string }>;
  const hasGhNodeId = cols.some((c) => c.name === 'gh_node_id');
  if (!hasGhNodeId) {
    db.exec('ALTER TABLE comments ADD COLUMN gh_node_id TEXT');
  }
}
