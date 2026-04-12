import type {
  Chunk,
  ChunkMetadata,
  ChunkWithDetails,
  Comment,
  DiffSide,
  FileStatus,
  Priority,
  Tag,
} from '@pr-review/shared';
import type Database from 'better-sqlite3';

export interface ChunkServiceOptions {
  db: Database.Database;
}

/**
 * Service for chunk CRUD operations, tag management, and review state.
 *
 * Approval state, tags, and metadata are keyed by (pr_id, content_hash)
 * in separate tables, so they survive chunk row deletion during sync.
 * Chunk row IDs are ephemeral — they change every sync cycle.
 */
export class ChunkService {
  private readonly db: Database.Database;

  constructor(options: ChunkServiceOptions) {
    this.db = options.db;
  }

  /**
   * Get all chunks for a PR with their tags, metadata, and comments.
   */
  getChunksForPr(prId: number): ChunkWithDetails[] {
    const chunks = this.db
      .prepare('SELECT * FROM chunks WHERE pr_id = ? ORDER BY file_path, chunk_index')
      .all(prId) as ChunkDbRow[];

    return chunks.map((c) => this.enrichChunk(c));
  }

  /**
   * Get a single chunk by ID with full details.
   */
  getChunk(chunkId: number): ChunkWithDetails | null {
    const chunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as
      | ChunkDbRow
      | undefined;
    if (!chunk) return null;
    return this.enrichChunk(chunk);
  }

  /**
   * Toggle the approved state of a chunk.
   * Reads current state from chunk_reviews, flips it, and upserts.
   */
  toggleApproved(chunkId: number): ChunkWithDetails {
    const chunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as
      | ChunkDbRow
      | undefined;
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);

    const review = this.db
      .prepare('SELECT * FROM chunk_reviews WHERE pr_id = ? AND content_hash = ?')
      .get(chunk.pr_id, chunk.content_hash) as ReviewDbRow | undefined;

    const currentlyApproved = review?.approved === 1;
    const newApproved = currentlyApproved ? 0 : 1;

    if (newApproved) {
      this.db
        .prepare(
          `INSERT INTO chunk_reviews (pr_id, content_hash, approved, approved_at)
           VALUES (?, ?, 1, datetime('now'))
           ON CONFLICT (pr_id, content_hash) DO UPDATE SET approved = 1, approved_at = datetime('now')`,
        )
        .run(chunk.pr_id, chunk.content_hash);
    } else {
      this.db
        .prepare(
          `INSERT INTO chunk_reviews (pr_id, content_hash, approved, approved_at)
           VALUES (?, ?, 0, NULL)
           ON CONFLICT (pr_id, content_hash) DO UPDATE SET approved = 0, approved_at = NULL`,
        )
        .run(chunk.pr_id, chunk.content_hash);
    }

    return this.enrichChunk(chunk);
  }

  /**
   * Mark a chunk as approved.
   */
  markApproved(chunkId: number): void {
    const chunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as
      | ChunkDbRow
      | undefined;
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);

    this.db
      .prepare(
        `INSERT INTO chunk_reviews (pr_id, content_hash, approved, approved_at)
         VALUES (?, ?, 1, datetime('now'))
         ON CONFLICT (pr_id, content_hash) DO UPDATE SET approved = 1, approved_at = datetime('now')`,
      )
      .run(chunk.pr_id, chunk.content_hash);
  }

  /**
   * Mark a chunk as unapproved.
   */
  markUnapproved(chunkId: number): void {
    const chunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as
      | ChunkDbRow
      | undefined;
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);

    this.db
      .prepare(
        `INSERT INTO chunk_reviews (pr_id, content_hash, approved, approved_at)
         VALUES (?, ?, 0, NULL)
         ON CONFLICT (pr_id, content_hash) DO UPDATE SET approved = 0, approved_at = NULL`,
      )
      .run(chunk.pr_id, chunk.content_hash);
  }

  /**
   * Bulk approve: mark all chunks with a given tag as approved.
   * Finds chunks via chunk_tags (keyed by pr_id, content_hash), then
   * upserts into chunk_reviews for each.
   */
  bulkApproveByTag(prId: number, tagId: number): number {
    // Find all content hashes that have this tag and are not yet approved
    const hashesToApprove = this.db
      .prepare(
        `SELECT DISTINCT ct.content_hash FROM chunk_tags ct
         WHERE ct.pr_id = ? AND ct.tag_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM chunk_reviews cr
             WHERE cr.pr_id = ct.pr_id AND cr.content_hash = ct.content_hash AND cr.approved = 1
           )`,
      )
      .all(prId, tagId) as Array<{ content_hash: string }>;

    if (hashesToApprove.length === 0) return 0;

    const upsert = this.db.prepare(
      `INSERT INTO chunk_reviews (pr_id, content_hash, approved, approved_at)
       VALUES (?, ?, 1, datetime('now'))
       ON CONFLICT (pr_id, content_hash) DO UPDATE SET approved = 1, approved_at = datetime('now')`,
    );

    const tx = this.db.transaction(() => {
      for (const row of hashesToApprove) {
        upsert.run(prId, row.content_hash);
      }
    });
    tx();

    return hashesToApprove.length;
  }

  /**
   * Update chunk metadata (priority, review note).
   * Keyed by (pr_id, content_hash).
   */
  updateMetadata(chunkId: number, priority?: Priority, reviewNote?: string | null): void {
    const chunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as
      | ChunkDbRow
      | undefined;
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);

    const existing = this.db
      .prepare('SELECT * FROM chunk_metadata WHERE pr_id = ? AND content_hash = ?')
      .get(chunk.pr_id, chunk.content_hash) as MetadataDbRow | undefined;

    if (existing) {
      this.db
        .prepare(
          'UPDATE chunk_metadata SET priority = ?, review_note = ? WHERE pr_id = ? AND content_hash = ?',
        )
        .run(
          priority ?? existing.priority,
          reviewNote !== undefined ? reviewNote : existing.review_note,
          chunk.pr_id,
          chunk.content_hash,
        );
    } else {
      this.db
        .prepare(
          'INSERT INTO chunk_metadata (pr_id, content_hash, priority, review_note) VALUES (?, ?, ?, ?)',
        )
        .run(chunk.pr_id, chunk.content_hash, priority ?? 'medium', reviewNote ?? null);
    }
  }

  /**
   * Get all tags for a specific PR.
   */
  getTagsForPr(prId: number): Tag[] {
    const rows = this.db
      .prepare('SELECT * FROM tags WHERE pr_id = ? ORDER BY name')
      .all(prId) as TagDbRow[];
    return rows.map(mapTagRow);
  }

  /**
   * Get total additions and deletions for a PR by scanning chunk diff text.
   *
   * Chunk diffText only contains hunk content (the `@@` header + diff lines).
   * The `+++ b/...` and `--- a/...` file-level headers are never stored,
   * so every line starting with `+` is a genuine addition and every line
   * starting with `-` is a genuine deletion — no need to exclude `+++`/`---`.
   */
  getDiffStats(prId: number): { additions: number; deletions: number } {
    const rows = this.db
      .prepare('SELECT diff_text FROM chunks WHERE pr_id = ?')
      .all(prId) as Array<{ diff_text: string }>;

    let additions = 0;
    let deletions = 0;
    for (const row of rows) {
      for (const line of row.diff_text.split('\n')) {
        if (line.startsWith('+')) {
          additions++;
        } else if (line.startsWith('-')) {
          deletions++;
        }
      }
    }
    return { additions, deletions };
  }

  /**
   * Add tags to a chunk. Resolves chunk ID to (pr_id, content_hash).
   */
  addTagsToChunk(chunkId: number, tagIds: number[]): void {
    const chunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as
      | ChunkDbRow
      | undefined;
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);

    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO chunk_tags (pr_id, content_hash, tag_id) VALUES (?, ?, ?)',
    );
    const insertAll = this.db.transaction(() => {
      for (const tagId of tagIds) {
        insert.run(chunk.pr_id, chunk.content_hash, tagId);
      }
    });
    insertAll();
  }

  /**
   * Remove a tag from a chunk.
   */
  removeTagFromChunk(chunkId: number, tagId: number): void {
    const chunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as
      | ChunkDbRow
      | undefined;
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);

    this.db
      .prepare('DELETE FROM chunk_tags WHERE pr_id = ? AND content_hash = ? AND tag_id = ?')
      .run(chunk.pr_id, chunk.content_hash, tagId);
  }

  /**
   * Set tags for a chunk (replace all existing).
   */
  setChunkTags(chunkId: number, tagIds: number[]): void {
    const chunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as
      | ChunkDbRow
      | undefined;
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);

    const tx = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM chunk_tags WHERE pr_id = ? AND content_hash = ?')
        .run(chunk.pr_id, chunk.content_hash);
      const insert = this.db.prepare(
        'INSERT INTO chunk_tags (pr_id, content_hash, tag_id) VALUES (?, ?, ?)',
      );
      for (const tagId of tagIds) {
        insert.run(chunk.pr_id, chunk.content_hash, tagId);
      }
    });
    tx();
  }

  // ── Private ─────────────────────────────────────────────

  private enrichChunk(row: ChunkDbRow): ChunkWithDetails {
    // Approval state from chunk_reviews
    const review = this.db
      .prepare('SELECT * FROM chunk_reviews WHERE pr_id = ? AND content_hash = ?')
      .get(row.pr_id, row.content_hash) as ReviewDbRow | undefined;

    // Tags via chunk_tags (keyed by pr_id, content_hash)
    const tags = this.db
      .prepare(
        `SELECT t.* FROM tags t
         JOIN chunk_tags ct ON ct.tag_id = t.id
         WHERE ct.pr_id = ? AND ct.content_hash = ?
         ORDER BY t.name`,
      )
      .all(row.pr_id, row.content_hash) as TagDbRow[];

    // Metadata via chunk_metadata (keyed by pr_id, content_hash)
    const metadata = this.db
      .prepare('SELECT * FROM chunk_metadata WHERE pr_id = ? AND content_hash = ?')
      .get(row.pr_id, row.content_hash) as MetadataDbRow | undefined;

    // Comments still linked via chunk_id (ephemeral — recreated each sync)
    const comments = this.db
      .prepare('SELECT * FROM comments WHERE chunk_id = ? ORDER BY created_at')
      .all(row.id) as CommentDbRow[];

    return {
      ...mapChunkRow(row),
      approved: review ? Boolean(review.approved) : false,
      approvedAt: review?.approved_at ?? null,
      tags: tags.map(mapTagRow),
      metadata: metadata ? mapMetadataRow(metadata) : null,
      comments: comments.map(mapCommentRow),
    };
  }
}

// ── DB Row Types ──────────────────────────────────────────────

interface ChunkDbRow {
  id: number;
  pr_id: number;
  file_path: string;
  chunk_index: number;
  content_hash: string;
  diff_text: string;
  start_line: number;
  end_line: number;
  old_start_line: number;
  old_end_line: number;
  file_status: string;
}

interface ReviewDbRow {
  pr_id: number;
  content_hash: string;
  approved: number;
  approved_at: string | null;
}

interface TagDbRow {
  id: number;
  pr_id: number;
  name: string;
  description: string;
}

interface MetadataDbRow {
  pr_id: number;
  content_hash: string;
  priority: string;
  review_note: string | null;
  llm_run_id: number | null;
}

interface CommentDbRow {
  id: number;
  chunk_id: number;
  pr_id: number;
  body: string;
  line: number;
  side: string;
  parent_id: number | null;
  author: string | null;
  gh_comment_id: number | null;
  gh_node_id: string | null;
  resolved: number;
  created_at: string;
  published_at: string | null;
}

// ── Mappers ───────────────────────────────────────────────────

function mapChunkRow(row: ChunkDbRow): Chunk {
  return {
    id: row.id,
    prId: row.pr_id,
    filePath: row.file_path,
    chunkIndex: row.chunk_index,
    contentHash: row.content_hash,
    diffText: row.diff_text,
    startLine: row.start_line,
    endLine: row.end_line,
    oldStartLine: row.old_start_line,
    oldEndLine: row.old_end_line,
    fileStatus: row.file_status as FileStatus,
  };
}

function mapTagRow(row: TagDbRow): Tag {
  return {
    id: row.id,
    prId: row.pr_id,
    name: row.name,
    description: row.description,
  };
}

function mapMetadataRow(row: MetadataDbRow): ChunkMetadata {
  return {
    prId: row.pr_id,
    contentHash: row.content_hash,
    priority: row.priority as Priority,
    reviewNote: row.review_note,
    llmRunId: row.llm_run_id,
  };
}

function mapCommentRow(row: CommentDbRow): Comment {
  return {
    id: row.id,
    chunkId: row.chunk_id,
    prId: row.pr_id,
    body: row.body,
    line: row.line,
    side: (row.side === 'LEFT' ? 'LEFT' : 'RIGHT') as DiffSide,
    parentId: row.parent_id,
    author: row.author,
    ghCommentId: row.gh_comment_id,
    ghNodeId: row.gh_node_id,
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}
