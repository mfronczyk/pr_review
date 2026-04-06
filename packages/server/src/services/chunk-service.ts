import type {
  Chunk,
  ChunkMetadata,
  ChunkWithDetails,
  Comment,
  Priority,
  Tag,
} from '@pr-review/shared';
import type Database from 'better-sqlite3';

export interface ChunkServiceOptions {
  db: Database.Database;
}

/**
 * Service for chunk CRUD operations, tag management, and review state.
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
   */
  toggleApproved(chunkId: number): Chunk {
    const chunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as
      | ChunkDbRow
      | undefined;
    if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);

    const newApproved = chunk.approved ? 0 : 1;
    const approvedAt = newApproved ? new Date().toISOString() : null;

    this.db
      .prepare('UPDATE chunks SET approved = ?, approved_at = ? WHERE id = ?')
      .run(newApproved, approvedAt, chunkId);

    return mapChunkRow({ ...chunk, approved: newApproved, approved_at: approvedAt });
  }

  /**
   * Mark a chunk as approved.
   */
  markApproved(chunkId: number): void {
    this.db
      .prepare("UPDATE chunks SET approved = 1, approved_at = datetime('now') WHERE id = ?")
      .run(chunkId);
  }

  /**
   * Mark a chunk as unapproved.
   */
  markUnapproved(chunkId: number): void {
    this.db.prepare('UPDATE chunks SET approved = 0, approved_at = NULL WHERE id = ?').run(chunkId);
  }

  /**
   * Bulk approve: mark all chunks with a given tag as approved.
   */
  bulkApproveByTag(prId: number, tagId: number): number {
    const result = this.db
      .prepare(
        `UPDATE chunks SET approved = 1, approved_at = datetime('now')
       WHERE pr_id = ? AND id IN (
         SELECT chunk_id FROM chunk_tags WHERE tag_id = ?
       ) AND approved = 0`,
      )
      .run(prId, tagId);

    return result.changes;
  }

  /**
   * Update chunk metadata (priority, review note).
   */
  updateMetadata(chunkId: number, priority?: Priority, reviewNote?: string | null): void {
    const existing = this.db
      .prepare('SELECT * FROM chunk_metadata WHERE chunk_id = ?')
      .get(chunkId) as MetadataDbRow | undefined;

    if (existing) {
      this.db
        .prepare('UPDATE chunk_metadata SET priority = ?, review_note = ? WHERE chunk_id = ?')
        .run(
          priority ?? existing.priority,
          reviewNote !== undefined ? reviewNote : existing.review_note,
          chunkId,
        );
    } else {
      this.db
        .prepare('INSERT INTO chunk_metadata (chunk_id, priority, review_note) VALUES (?, ?, ?)')
        .run(chunkId, priority ?? 'medium', reviewNote ?? null);
    }
  }

  /**
   * Get all tags.
   */
  getAllTags(): Tag[] {
    const rows = this.db
      .prepare('SELECT * FROM tags ORDER BY is_default DESC, name')
      .all() as TagDbRow[];
    return rows.map(mapTagRow);
  }

  /**
   * Get total additions and deletions for a PR by scanning chunk diff text.
   */
  getDiffStats(prId: number): { additions: number; deletions: number } {
    const rows = this.db
      .prepare('SELECT diff_text FROM chunks WHERE pr_id = ?')
      .all(prId) as Array<{ diff_text: string }>;

    let additions = 0;
    let deletions = 0;
    for (const row of rows) {
      for (const line of row.diff_text.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletions++;
        }
      }
    }
    return { additions, deletions };
  }

  /**
   * Add tags to a chunk.
   */
  addTagsToChunk(chunkId: number, tagIds: number[]): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO chunk_tags (chunk_id, tag_id) VALUES (?, ?)',
    );
    const insertAll = this.db.transaction(() => {
      for (const tagId of tagIds) {
        insert.run(chunkId, tagId);
      }
    });
    insertAll();
  }

  /**
   * Remove a tag from a chunk.
   */
  removeTagFromChunk(chunkId: number, tagId: number): void {
    this.db.prepare('DELETE FROM chunk_tags WHERE chunk_id = ? AND tag_id = ?').run(chunkId, tagId);
  }

  /**
   * Set tags for a chunk (replace all existing).
   */
  setChunkTags(chunkId: number, tagIds: number[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunk_tags WHERE chunk_id = ?').run(chunkId);
      const insert = this.db.prepare('INSERT INTO chunk_tags (chunk_id, tag_id) VALUES (?, ?)');
      for (const tagId of tagIds) {
        insert.run(chunkId, tagId);
      }
    });
    tx();
  }

  // ── Private ─────────────────────────────────────────────

  private enrichChunk(row: ChunkDbRow): ChunkWithDetails {
    const tags = this.db
      .prepare(
        `SELECT t.* FROM tags t
       JOIN chunk_tags ct ON ct.tag_id = t.id
       WHERE ct.chunk_id = ?
       ORDER BY t.name`,
      )
      .all(row.id) as TagDbRow[];

    const metadata = this.db
      .prepare('SELECT * FROM chunk_metadata WHERE chunk_id = ?')
      .get(row.id) as MetadataDbRow | undefined;

    const comments = this.db
      .prepare('SELECT * FROM comments WHERE chunk_id = ? ORDER BY created_at')
      .all(row.id) as CommentDbRow[];

    return {
      ...mapChunkRow(row),
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
  approved: number;
  approved_at: string | null;
}

interface TagDbRow {
  id: number;
  name: string;
  description: string;
  color: string;
  is_default: number;
}

interface MetadataDbRow {
  chunk_id: number;
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
  parent_id: number | null;
  author: string | null;
  gh_comment_id: number | null;
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
    approved: Boolean(row.approved),
    approvedAt: row.approved_at,
  };
}

function mapTagRow(row: TagDbRow): Tag {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    isDefault: Boolean(row.is_default),
  };
}

function mapMetadataRow(row: MetadataDbRow): ChunkMetadata {
  return {
    chunkId: row.chunk_id,
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
    parentId: row.parent_id,
    author: row.author,
    ghCommentId: row.gh_comment_id,
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}
