import type BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ParsedFileDiff } from './diff-parser.js';
import {
  buildAnalysisPrompt,
  buildTaggingSystemPrompt,
  mapTaggingResult,
  storeChunkMetadata,
  validatePriority,
} from './llm-analyzer.js';

const SAMPLE_FILE_DIFFS: ParsedFileDiff[] = [
  {
    filePath: 'src/requests/utils.py',
    status: 'modified',
    oldPath: null,
    chunks: [
      {
        filePath: 'src/requests/utils.py',
        chunkIndex: 0,
        diffText:
          '@@ -10,6 +10,7 @@\n import sys\n import tempfile\n+from typing import Optional\n',
        contentHash: 'abc123',
        startLine: 10,
        endLine: 16,
        oldStartLine: 10,
        oldEndLine: 15,
        fileStatus: 'modified',
      },
      {
        filePath: 'src/requests/utils.py',
        chunkIndex: 1,
        diffText: '@@ -45,7 +46,7 @@\n-    old_call()\n+    new_call()\n',
        contentHash: 'def456',
        startLine: 46,
        endLine: 52,
        oldStartLine: 45,
        oldEndLine: 51,
        fileStatus: 'modified',
      },
    ],
  },
  {
    filePath: 'src/requests/_types.py',
    status: 'added',
    oldPath: null,
    chunks: [
      {
        filePath: 'src/requests/_types.py',
        chunkIndex: 0,
        diffText: '@@ -0,0 +1,10 @@\n+"""Types module."""\n+from typing import TypeAlias\n',
        contentHash: 'ghi789',
        startLine: 1,
        endLine: 10,
        oldStartLine: 0,
        oldEndLine: 0,
        fileStatus: 'added',
      },
    ],
  },
];

describe('buildAnalysisPrompt', () => {
  it('should include PR metadata and head branch', () => {
    const prompt = buildAnalysisPrompt(
      'Add inline types',
      'This PR adds type annotations.',
      'nateprewitt',
      'main',
      'feature/add-types',
      ['feat: add type annotations', 'fix: correct import order'],
      SAMPLE_FILE_DIFFS,
    );

    expect(prompt).toContain('Add inline types');
    expect(prompt).toContain('nateprewitt');
    expect(prompt).toContain('main');
    expect(prompt).toContain('feature/add-types');
    expect(prompt).toContain('This PR adds type annotations.');
  });

  it('should include commit messages', () => {
    const prompt = buildAnalysisPrompt(
      'Title',
      'Body',
      'author',
      'main',
      'feature/branch',
      ['feat: add type annotations', 'fix: correct import order'],
      SAMPLE_FILE_DIFFS,
    );

    expect(prompt).toContain('feat: add type annotations');
    expect(prompt).toContain('fix: correct import order');
  });

  it('should include all file paths', () => {
    const prompt = buildAnalysisPrompt(
      'Title',
      'Body',
      'author',
      'main',
      'feature/branch',
      [],
      SAMPLE_FILE_DIFFS,
    );

    expect(prompt).toContain('src/requests/utils.py');
    expect(prompt).toContain('src/requests/_types.py');
  });

  it('should include file status', () => {
    const prompt = buildAnalysisPrompt(
      'Title',
      'Body',
      'author',
      'main',
      'feature/branch',
      [],
      SAMPLE_FILE_DIFFS,
    );

    expect(prompt).toContain('=== MODIFIED: src/requests/utils.py ===');
    expect(prompt).toContain('=== ADDED: src/requests/_types.py ===');
  });

  it('should include chunk markers in diff', () => {
    const prompt = buildAnalysisPrompt(
      'Title',
      'Body',
      'author',
      'main',
      'feature/branch',
      [],
      SAMPLE_FILE_DIFFS,
    );

    expect(prompt).toContain('--- chunk 0 ---');
    expect(prompt).toContain('--- chunk 1 ---');
  });

  it('should include diff content', () => {
    const prompt = buildAnalysisPrompt(
      'Title',
      'Body',
      'author',
      'main',
      'feature/branch',
      [],
      SAMPLE_FILE_DIFFS,
    );

    expect(prompt).toContain('+from typing import Optional');
    expect(prompt).toContain('+"""Types module."""');
  });

  it('should handle empty body', () => {
    const prompt = buildAnalysisPrompt(
      'Title',
      '',
      'author',
      'main',
      'feature/branch',
      [],
      SAMPLE_FILE_DIFFS,
    );

    expect(prompt).toContain('(no description)');
  });

  it('should handle renamed files', () => {
    const diffs: ParsedFileDiff[] = [
      {
        filePath: 'new_name.py',
        status: 'renamed',
        oldPath: 'old_name.py',
        chunks: [],
      },
    ];

    const prompt = buildAnalysisPrompt(
      'Title',
      'Body',
      'author',
      'main',
      'feature/branch',
      [],
      diffs,
    );
    expect(prompt).toContain('=== RENAMED: new_name.py (was: old_name.py) ===');
  });

  it('should not include instructions (moved to system prompt)', () => {
    const prompt = buildAnalysisPrompt(
      'Title',
      'Body',
      'author',
      'main',
      'feature/branch',
      [],
      SAMPLE_FILE_DIFFS,
    );

    // Instructions and taxonomy are in the system prompt, not the user prompt
    expect(prompt).not.toContain('You are a senior code reviewer');
    expect(prompt).not.toContain('Tag Taxonomy');
  });
});

describe('buildTaggingSystemPrompt', () => {
  it('should include role and tag taxonomy', () => {
    const system = buildTaggingSystemPrompt();

    expect(system).toContain('senior code reviewer');
    expect(system).toContain('Layer');
    expect(system).toContain('Functionality');
  });

  it('should include tagging instructions but not summary instructions', () => {
    const system = buildTaggingSystemPrompt();

    expect(system).toContain('Define Tags');
    expect(system).toContain('Assign Chunks');
    expect(system).not.toContain('PR Summary');
    expect(system).not.toContain('Tag Summaries');
  });
});

describe('validatePriority', () => {
  it('should return valid priority values unchanged', () => {
    expect(validatePriority('high')).toBe('high');
    expect(validatePriority('medium')).toBe('medium');
    expect(validatePriority('low')).toBe('low');
  });

  it('should default unknown values to medium', () => {
    expect(validatePriority('critical')).toBe('medium');
    expect(validatePriority('')).toBe('medium');
    expect(validatePriority('unknown')).toBe('medium');
  });
});

describe('mapTaggingResult', () => {
  it('should map snake_case chunk assignments to camelCase', () => {
    const raw = {
      tags: [{ name: 'api', description: 'API changes' }],
      chunk_assignments: [
        {
          file_path: 'src/api.ts',
          chunk_index: 2,
          tags: ['api'],
          priority: 'high',
          review_note: 'Check error handling',
        },
      ],
    };

    const result = mapTaggingResult(raw);

    expect(result.tags).toHaveLength(1);
    expect(result.tags[0]).toEqual({ name: 'api', description: 'API changes' });

    expect(result.chunkAssignments).toHaveLength(1);
    expect(result.chunkAssignments[0]).toEqual({
      filePath: 'src/api.ts',
      chunkIndex: 2,
      tags: ['api'],
      priority: 'high',
      reviewNote: 'Check error handling',
    });
  });

  it('should validate and normalize priority', () => {
    const raw = {
      tags: [],
      chunk_assignments: [
        {
          file_path: 'foo.ts',
          chunk_index: 0,
          tags: [],
          priority: 'critical',
          review_note: null,
        },
      ],
    };

    const result = mapTaggingResult(raw);
    expect(result.chunkAssignments[0].priority).toBe('medium');
  });
});

// ── storeChunkMetadata ───────────────────────────────────────

async function setupTestDb(): Promise<{
  db: BetterSqlite3.Database;
  prId: number;
  chunkIds: number[];
}> {
  const { initDatabase } = await import('../db/schema.js');
  const db = initDatabase(':memory:');

  const pr = db
    .prepare(
      `INSERT INTO prs (owner, repo, number, title, author, base_ref, head_ref, head_sha, body)
       VALUES ('test-org', 'test-repo', 42, 'Add types', 'testauthor', 'main', 'feature/types', 'abc123', 'Adds type annotations')
       RETURNING id`,
    )
    .get() as { id: number };

  const insertChunk = db.prepare(
    `INSERT INTO chunks (pr_id, file_path, chunk_index, content_hash, diff_text, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );

  const chunk1 = insertChunk.get(
    pr.id,
    'src/requests/utils.py',
    0,
    'abc123',
    '@@ -10,6 +10,7 @@\n import sys\n import tempfile\n+from typing import Optional\n',
    10,
    16,
  ) as { id: number };

  const chunk2 = insertChunk.get(
    pr.id,
    'src/requests/utils.py',
    1,
    'def456',
    '@@ -45,7 +46,7 @@\n-    old_call()\n+    new_call()\n',
    46,
    52,
  ) as { id: number };

  const chunk3 = insertChunk.get(
    pr.id,
    'src/requests/_types.py',
    0,
    'ghi789',
    '@@ -0,0 +1,10 @@\n+"""Types module."""\n+from typing import TypeAlias\n',
    1,
    10,
  ) as { id: number };

  return { db, prId: pr.id, chunkIds: [chunk1.id, chunk2.id, chunk3.id] };
}

const MOCK_ASSIGNMENTS = [
  {
    filePath: 'src/requests/utils.py',
    chunkIndex: 0,
    tags: ['type-annotations'],
    priority: 'medium' as const,
    reviewNote: null,
  },
  {
    filePath: 'src/requests/utils.py',
    chunkIndex: 1,
    tags: ['type-annotations'],
    priority: 'low' as const,
    reviewNote: null,
  },
  {
    filePath: 'src/requests/_types.py',
    chunkIndex: 0,
    tags: ['type-definitions'],
    priority: 'high' as const,
    reviewNote: 'New module — review the public API surface.',
  },
];

const MOCK_TAG_DEFINITIONS = [
  { name: 'type-annotations', description: 'Type annotation additions' },
  { name: 'type-definitions', description: 'New type definition files' },
];

describe('storeChunkMetadata', () => {
  it('should store chunk metadata and tags in DB', async () => {
    const { db, prId } = await setupTestDb();

    // Insert a fake llm_run
    const run = db
      .prepare("INSERT INTO llm_runs (pr_id, status) VALUES (?, 'completed') RETURNING id")
      .get(prId) as { id: number };

    storeChunkMetadata(db, prId, run.id, MOCK_ASSIGNMENTS, MOCK_TAG_DEFINITIONS);

    // Tags should be created
    const tags = db.prepare('SELECT name FROM tags WHERE pr_id = ? ORDER BY name').all(prId) as {
      name: string;
    }[];
    expect(tags.map((t) => t.name)).toEqual(['type-annotations', 'type-definitions']);

    // chunk_metadata should be stored
    const metadata = db
      .prepare('SELECT priority, review_note FROM chunk_metadata WHERE pr_id = ?')
      .all(prId) as { priority: string; review_note: string | null }[];
    expect(metadata).toHaveLength(3);

    // chunk_tags should link chunks to tags
    const chunkTags = db
      .prepare(
        `SELECT ct.content_hash, t.name
         FROM chunk_tags ct JOIN tags t ON ct.tag_id = t.id
         WHERE ct.pr_id = ?
         ORDER BY ct.content_hash, t.name`,
      )
      .all(prId) as { content_hash: string; name: string }[];

    expect(chunkTags).toEqual([
      { content_hash: 'abc123', name: 'type-annotations' },
      { content_hash: 'def456', name: 'type-annotations' },
      { content_hash: 'ghi789', name: 'type-definitions' },
    ]);

    db.close();
  });

  it('should assign unassigned tag to chunks with no tags', async () => {
    const { db, prId } = await setupTestDb();

    const run = db
      .prepare("INSERT INTO llm_runs (pr_id, status) VALUES (?, 'completed') RETURNING id")
      .get(prId) as { id: number };

    // Only assign 2 of 3 chunks
    const partialAssignments = MOCK_ASSIGNMENTS.slice(0, 2);
    storeChunkMetadata(db, prId, run.id, partialAssignments, MOCK_TAG_DEFINITIONS);

    // The third chunk should get the 'unassigned' tag
    const unassignedTag = db
      .prepare("SELECT id FROM tags WHERE name = 'unassigned' AND pr_id = ?")
      .get(prId) as { id: number } | undefined;
    expect(unassignedTag).toBeDefined();
    if (!unassignedTag) return;

    const unassignedChunkTags = db
      .prepare(
        `SELECT ct.content_hash FROM chunk_tags ct
         WHERE ct.pr_id = ? AND ct.tag_id = ?`,
      )
      .all(prId, unassignedTag.id) as { content_hash: string }[];
    expect(unassignedChunkTags).toHaveLength(1);
    expect(unassignedChunkTags[0].content_hash).toBe('ghi789');

    db.close();
  });

  it('should replace existing tags on re-run', async () => {
    const { db, prId } = await setupTestDb();

    const run1 = db
      .prepare("INSERT INTO llm_runs (pr_id, status) VALUES (?, 'completed') RETURNING id")
      .get(prId) as { id: number };

    storeChunkMetadata(db, prId, run1.id, MOCK_ASSIGNMENTS, MOCK_TAG_DEFINITIONS);

    // Re-run with different tags
    const run2 = db
      .prepare("INSERT INTO llm_runs (pr_id, status) VALUES (?, 'completed') RETURNING id")
      .get(prId) as { id: number };

    const newAssignments = [
      {
        filePath: 'src/requests/utils.py',
        chunkIndex: 0,
        tags: ['refactoring'],
        priority: 'low' as const,
        reviewNote: null,
      },
      {
        filePath: 'src/requests/utils.py',
        chunkIndex: 1,
        tags: ['refactoring'],
        priority: 'low' as const,
        reviewNote: null,
      },
      {
        filePath: 'src/requests/_types.py',
        chunkIndex: 0,
        tags: ['refactoring'],
        priority: 'medium' as const,
        reviewNote: null,
      },
    ];

    storeChunkMetadata(db, prId, run2.id, newAssignments, [
      { name: 'refactoring', description: 'Refactoring changes' },
    ]);

    // Only 'refactoring' tag should be assigned to all chunks now
    const chunkTags = db
      .prepare(
        `SELECT t.name FROM chunk_tags ct
         JOIN tags t ON ct.tag_id = t.id
         WHERE ct.pr_id = ?
         GROUP BY t.name`,
      )
      .all(prId) as { name: string }[];

    expect(chunkTags.map((t) => t.name)).toContain('refactoring');
    // Old tags should no longer be assigned (chunk_tags cleared and re-assigned)
    expect(chunkTags.map((t) => t.name)).not.toContain('type-annotations');

    db.close();
  });
});
