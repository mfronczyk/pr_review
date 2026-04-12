import type BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { ParsedFileDiff } from './diff-parser.js';
import {
  buildAnalysisPrompt,
  buildSummaryPrompt,
  buildSummarySystemPrompt,
  buildTaggingSystemPrompt,
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
      },
      {
        filePath: 'src/requests/utils.py',
        chunkIndex: 1,
        diffText: '@@ -45,7 +46,7 @@\n-    old_call()\n+    new_call()\n',
        contentHash: 'def456',
        startLine: 46,
        endLine: 52,
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

describe('buildSummarySystemPrompt', () => {
  it('should include summarizer role', () => {
    const system = buildSummarySystemPrompt();

    expect(system).toContain('senior code reviewer');
    expect(system).toContain('summary');
  });
});

describe('buildSummaryPrompt', () => {
  it('should include tag name, description, and chunk content', () => {
    const prompt = buildSummaryPrompt(
      'database-migration',
      'Database schema changes',
      [{ filePath: 'schema.ts', chunkIndex: 0, diffText: '+ALTER TABLE users ADD COLUMN email' }],
      'Add user emails',
      'Adds email column to users table',
    );

    expect(prompt).toContain('database-migration');
    expect(prompt).toContain('Database schema changes');
    expect(prompt).toContain('schema.ts chunk 0');
    expect(prompt).toContain('+ALTER TABLE users ADD COLUMN email');
    expect(prompt).toContain('Add user emails');
  });
});

describe('TAGGING_SCHEMA', () => {
  it('should be a valid JSON schema with tags and chunk_assignments', async () => {
    const { TAGGING_SCHEMA } = await import('./llm-analyzer.js');

    expect(TAGGING_SCHEMA.type).toBe('object');
    expect(TAGGING_SCHEMA.required).toContain('tags');
    expect(TAGGING_SCHEMA.required).toContain('chunk_assignments');
    expect(TAGGING_SCHEMA.required).not.toContain('pr_summary');
    expect(TAGGING_SCHEMA.required).not.toContain('tag_summaries');
    expect(TAGGING_SCHEMA.properties.chunk_assignments.type).toBe('array');
  });
});

describe('SUMMARY_SCHEMA', () => {
  it('should be a valid JSON schema with summary field', async () => {
    const { SUMMARY_SCHEMA } = await import('./llm-analyzer.js');

    expect(SUMMARY_SCHEMA.type).toBe('object');
    expect(SUMMARY_SCHEMA.required).toContain('summary');
    expect(SUMMARY_SCHEMA.properties.summary.type).toBe('string');
  });
});

// ── analyzePr two-phase pipeline ────────────────────────────

/**
 * Create an in-memory SQLite database with the full schema and seed data
 * for analyzePr tests. Returns the db plus the PR id and chunk ids.
 */
async function setupTestDb(): Promise<{
  db: BetterSqlite3.Database;
  prId: number;
  chunkIds: number[];
}> {
  const { initDatabase } = await import('../db/schema.js');
  const db = initDatabase(':memory:');

  // Insert a PR
  const pr = db
    .prepare(
      `INSERT INTO prs (owner, repo, number, title, author, base_ref, head_ref, head_sha, body)
       VALUES ('test-org', 'test-repo', 42, 'Add types', 'testauthor', 'main', 'feature/types', 'abc123', 'Adds type annotations')
       RETURNING id`,
    )
    .get() as { id: number };

  // Insert chunks matching SAMPLE_FILE_DIFFS
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

/**
 * Create a mock async-iterable event stream that properly terminates
 * when `.return()` is called — unblocking any pending `next()`.
 */
function createMockEventStream() {
  let resolvePending: ((v: { done: boolean; value: undefined }) => void) | null = null;

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      return new Promise<{ done: boolean; value: undefined }>((resolve) => {
        resolvePending = resolve;
      });
    },
    return() {
      // Unblock any pending next() call
      resolvePending?.({ done: true, value: undefined });
      return Promise.resolve({ done: true as const, value: undefined });
    },
  };
}

/**
 * Build a mock SDK factory for analyzePr tests.
 * `promptHandler` is called for each session.prompt() call with the call args
 * and should return the structured output for that call.
 */
function mockAnalyzerSdk(options: {
  promptHandler: (args: {
    sessionID: string;
    system: string;
    parts: Array<{ type: string; text: string }>;
    format: { schema: unknown };
  }) => unknown;
  promptError?: Error;
}) {
  const serverClose = vi.fn();
  let sessionCounter = 0;

  return {
    createOpencode: vi.fn().mockResolvedValue({
      client: {
        session: {
          create: vi.fn().mockImplementation(({ title }: { title: string }) => {
            sessionCounter++;
            return Promise.resolve({
              data: { id: `session-${sessionCounter}`, title },
            });
          }),
          prompt: vi.fn().mockImplementation((args: Record<string, unknown>) => {
            if (options.promptError) {
              return Promise.reject(options.promptError);
            }
            const structured = options.promptHandler(
              args as Parameters<typeof options.promptHandler>[0],
            );
            return Promise.resolve({
              data: {
                info: {
                  structured,
                  error: undefined,
                },
              },
              response: { status: 200 },
            });
          }),
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: createMockEventStream(),
          }),
        },
      },
      server: { close: serverClose },
    }),
    serverClose,
  };
}

/** Standard tagging result for tests. */
const MOCK_TAGGING_RESULT = {
  tags: [
    { name: 'type-annotations', description: 'Type annotation additions' },
    { name: 'type-definitions', description: 'New type definition files' },
  ],
  chunk_assignments: [
    {
      file_path: 'src/requests/utils.py',
      chunk_index: 0,
      tags: ['type-annotations'],
      priority: 'medium',
      review_note: null,
    },
    {
      file_path: 'src/requests/utils.py',
      chunk_index: 1,
      tags: ['type-annotations'],
      priority: 'low',
      review_note: null,
    },
    {
      file_path: 'src/requests/_types.py',
      chunk_index: 0,
      tags: ['type-definitions'],
      priority: 'high',
      review_note: 'New module — review the public API surface.',
    },
  ],
};

describe('analyzePr', () => {
  it('should run both phases and return combined result', async () => {
    const { db, prId } = await setupTestDb();

    const mock = mockAnalyzerSdk({
      promptHandler: (args) => {
        const schema = args.format.schema as { required?: string[] };
        // Phase 1 uses TAGGING_SCHEMA (has 'chunk_assignments')
        if (schema.required?.includes('chunk_assignments')) {
          return MOCK_TAGGING_RESULT;
        }
        // Phase 2 uses SUMMARY_SCHEMA (has 'summary')
        if (schema.required?.includes('summary')) {
          const tagName = args.parts[0].text.match(/## Tag: (.+)/)?.[1] ?? 'unknown';
          return { summary: `Summary for ${tagName}` };
        }
        throw new Error('Unexpected schema');
      },
    });

    vi.doMock('@opencode-ai/sdk/v2', () => mock);
    const { analyzePr: analyze } = await import('./llm-analyzer.js');

    const result = await analyze(
      { db, repoPath: '/tmp/test' },
      prId,
      'Add types',
      'Adds type annotations',
      'testauthor',
      'main',
      'feature/types',
      ['feat: add types'],
      SAMPLE_FILE_DIFFS,
    );

    // Tags
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].name).toBe('type-annotations');
    expect(result.tags[1].name).toBe('type-definitions');

    // Chunk assignments
    expect(result.chunkAssignments).toHaveLength(3);
    expect(result.chunkAssignments[0]).toEqual({
      filePath: 'src/requests/utils.py',
      chunkIndex: 0,
      tags: ['type-annotations'],
      priority: 'medium',
      reviewNote: null,
    });
    expect(result.chunkAssignments[2].priority).toBe('high');
    expect(result.chunkAssignments[2].reviewNote).toBe(
      'New module — review the public API surface.',
    );

    // Tag summaries (Phase 2)
    expect(result.tagSummaries).toHaveLength(2);
    expect(result.tagSummaries.find((s) => s.tag === 'type-annotations')?.summary).toBe(
      'Summary for type-annotations',
    );
    expect(result.tagSummaries.find((s) => s.tag === 'type-definitions')?.summary).toBe(
      'Summary for type-definitions',
    );

    // DB: llm_run should be completed
    const run = db.prepare('SELECT status FROM llm_runs WHERE pr_id = ?').get(prId) as {
      status: string;
    };
    expect(run.status).toBe('completed');

    // DB: tags should be stored
    const tags = db.prepare('SELECT name FROM tags WHERE pr_id = ? ORDER BY name').all(prId) as {
      name: string;
    }[];
    expect(tags.map((t) => t.name)).toEqual(['type-annotations', 'type-definitions']);

    // DB: chunk_metadata should be stored
    const metadata = db.prepare('SELECT priority FROM chunk_metadata').all() as {
      priority: string;
    }[];
    expect(metadata).toHaveLength(3);

    // DB: tag_summaries should be stored
    const summaries = db.prepare('SELECT summary FROM tag_summaries WHERE pr_id = ?').all(prId) as {
      summary: string;
    }[];
    expect(summaries).toHaveLength(2);

    // Server should be closed
    expect(mock.serverClose).toHaveBeenCalled();

    db.close();
    vi.doUnmock('@opencode-ai/sdk/v2');
  });

  it('should handle Phase 2 partial failure gracefully', async () => {
    const { db, prId } = await setupTestDb();

    let summaryCallCount = 0;
    const mock = mockAnalyzerSdk({
      promptHandler: (args) => {
        const schema = args.format.schema as { required?: string[] };
        if (schema.required?.includes('chunk_assignments')) {
          return MOCK_TAGGING_RESULT;
        }
        if (schema.required?.includes('summary')) {
          summaryCallCount++;
          // Fail the second summary call
          if (summaryCallCount === 2) {
            throw new Error('Provider timeout');
          }
          const tagName = args.parts[0].text.match(/## Tag: (.+)/)?.[1] ?? 'unknown';
          return { summary: `Summary for ${tagName}` };
        }
        throw new Error('Unexpected schema');
      },
    });

    vi.doMock('@opencode-ai/sdk/v2', () => mock);
    const { analyzePr: analyze } = await import('./llm-analyzer.js');

    const result = await analyze(
      { db, repoPath: '/tmp/test' },
      prId,
      'Add types',
      'Adds type annotations',
      'testauthor',
      'main',
      'feature/types',
      [],
      SAMPLE_FILE_DIFFS,
    );

    // Only 1 of 2 summaries should succeed
    expect(result.tagSummaries).toHaveLength(1);
    expect(result.tagSummaries[0].tag).toBe('type-annotations');

    // Tags and assignments should still be complete
    expect(result.tags).toHaveLength(2);
    expect(result.chunkAssignments).toHaveLength(3);

    // Run should still be marked completed (partial summaries are OK)
    const run = db.prepare('SELECT status FROM llm_runs WHERE pr_id = ?').get(prId) as {
      status: string;
    };
    expect(run.status).toBe('completed');

    db.close();
    vi.doUnmock('@opencode-ai/sdk/v2');
  });

  it('should mark run as failed when Phase 1 errors', async () => {
    const { db, prId } = await setupTestDb();

    const mock = mockAnalyzerSdk({
      promptHandler: () => {
        throw new Error('LLM provider unavailable');
      },
    });

    vi.doMock('@opencode-ai/sdk/v2', () => mock);
    const { analyzePr: analyze } = await import('./llm-analyzer.js');

    await expect(
      analyze(
        { db, repoPath: '/tmp/test' },
        prId,
        'Add types',
        'Body',
        'testauthor',
        'main',
        'feature/types',
        [],
        SAMPLE_FILE_DIFFS,
      ),
    ).rejects.toThrow('LLM provider unavailable');

    // DB: run should be marked failed
    const run = db.prepare('SELECT status FROM llm_runs WHERE pr_id = ?').get(prId) as {
      status: string;
    };
    expect(run.status).toBe('failed');

    // Server should still be closed
    expect(mock.serverClose).toHaveBeenCalled();

    db.close();
    vi.doUnmock('@opencode-ai/sdk/v2');
  });

  it('should pass model override to both phases', async () => {
    const { db, prId } = await setupTestDb();

    const promptCalls: Array<{ model?: { providerID: string; modelID: string } }> = [];
    const mock = mockAnalyzerSdk({
      promptHandler: (args) => {
        promptCalls.push(args as unknown as (typeof promptCalls)[0]);
        const schema = args.format.schema as { required?: string[] };
        if (schema.required?.includes('chunk_assignments')) {
          return MOCK_TAGGING_RESULT;
        }
        return { summary: 'Test summary' };
      },
    });

    vi.doMock('@opencode-ai/sdk/v2', () => mock);
    const { analyzePr: analyze } = await import('./llm-analyzer.js');

    await analyze(
      { db, repoPath: '/tmp/test' },
      prId,
      'Add types',
      'Body',
      'testauthor',
      'main',
      'feature/types',
      [],
      SAMPLE_FILE_DIFFS,
      { provider: 'openai', model: 'gpt-4o' },
    );

    // All prompt calls (1 tagging + 2 summaries) should include the model override
    expect(promptCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of promptCalls) {
      expect(call.model).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
    }

    db.close();
    vi.doUnmock('@opencode-ai/sdk/v2');
  });

  it('should store chunk_tags linking chunks to tags in DB', async () => {
    const { db, prId, chunkIds } = await setupTestDb();

    const mock = mockAnalyzerSdk({
      promptHandler: (args) => {
        const schema = args.format.schema as { required?: string[] };
        if (schema.required?.includes('chunk_assignments')) {
          return MOCK_TAGGING_RESULT;
        }
        return { summary: 'Test summary' };
      },
    });

    vi.doMock('@opencode-ai/sdk/v2', () => mock);
    const { analyzePr: analyze } = await import('./llm-analyzer.js');

    await analyze(
      { db, repoPath: '/tmp/test' },
      prId,
      'Add types',
      'Body',
      'testauthor',
      'main',
      'feature/types',
      [],
      SAMPLE_FILE_DIFFS,
    );

    // chunk 0 (utils.py:0) and chunk 1 (utils.py:1) → type-annotations
    // chunk 2 (_types.py:0) → type-definitions
    const chunkTags = db
      .prepare(
        `SELECT ct.chunk_id, t.name
         FROM chunk_tags ct JOIN tags t ON ct.tag_id = t.id
         ORDER BY ct.chunk_id, t.name`,
      )
      .all() as { chunk_id: number; name: string }[];

    expect(chunkTags).toEqual([
      { chunk_id: chunkIds[0], name: 'type-annotations' },
      { chunk_id: chunkIds[1], name: 'type-annotations' },
      { chunk_id: chunkIds[2], name: 'type-definitions' },
    ]);

    db.close();
    vi.doUnmock('@opencode-ai/sdk/v2');
  });

  it('should use separate sessions for tagging and each summary', async () => {
    const { db, prId } = await setupTestDb();

    const sessionTitles: string[] = [];
    const serverClose = vi.fn();
    let sessionCounter = 0;

    const mockModule = {
      createOpencode: vi.fn().mockResolvedValue({
        client: {
          session: {
            create: vi.fn().mockImplementation(({ title }: { title: string }) => {
              sessionCounter++;
              sessionTitles.push(title);
              return Promise.resolve({
                data: { id: `session-${sessionCounter}`, title },
              });
            }),
            prompt: vi.fn().mockImplementation((args: Record<string, unknown>) => {
              const format = args.format as { schema: { required?: string[] } };
              if (format.schema.required?.includes('chunk_assignments')) {
                return Promise.resolve({
                  data: { info: { structured: MOCK_TAGGING_RESULT } },
                });
              }
              return Promise.resolve({
                data: { info: { structured: { summary: 'Test summary' } } },
              });
            }),
          },
          event: {
            subscribe: vi.fn().mockResolvedValue({
              stream: createMockEventStream(),
            }),
          },
        },
        server: { close: serverClose },
      }),
    };

    vi.doMock('@opencode-ai/sdk/v2', () => mockModule);
    const { analyzePr: analyze } = await import('./llm-analyzer.js');

    await analyze(
      { db, repoPath: '/tmp/test' },
      prId,
      'Add types',
      'Body',
      'testauthor',
      'main',
      'feature/types',
      [],
      SAMPLE_FILE_DIFFS,
    );

    // 1 tagging session + 2 summary sessions = 3 total
    expect(sessionTitles).toHaveLength(3);
    expect(sessionTitles[0]).toContain('Tagging');
    expect(sessionTitles).toContainEqual('Summary: type-annotations');
    expect(sessionTitles).toContainEqual('Summary: type-definitions');

    db.close();
    vi.doUnmock('@opencode-ai/sdk/v2');
  });
});

// ── validateOpenCode ────────────────────────────────────────

/**
 * Helper to create a mock SDK module with configurable config/providers responses.
 */
function mockSdk(options: {
  configModel?: string;
  providers?: Array<{ id: string; name: string; models: Record<string, { name: string }> }>;
  defaultMap?: Record<string, string>;
}) {
  const serverClose = vi.fn();
  return {
    createOpencode: vi.fn().mockResolvedValue({
      client: {
        config: {
          get: vi.fn().mockResolvedValue({
            data: { model: options.configModel },
          }),
          providers: vi.fn().mockResolvedValue({
            data: {
              providers: options.providers ?? [],
              default: options.defaultMap ?? {},
            },
          }),
        },
      },
      server: { close: serverClose },
    }),
    serverClose,
  };
}

describe('validateOpenCode', () => {
  it('should return model info from config model override', async () => {
    const mock = mockSdk({
      configModel: 'anthropic/claude-sonnet-4-20250514',
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: { 'claude-sonnet-4-20250514': { name: 'Claude Sonnet' } },
        },
      ],
    });
    vi.doMock('@opencode-ai/sdk/v2', () => mock);

    // Re-import to pick up the mock
    const { validateOpenCode: validate } = await import('./llm-analyzer.js');
    const result = await validate();

    expect(result.activeModel).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    expect(result.availableModels).toHaveLength(1);
    expect(mock.serverClose).toHaveBeenCalled();

    vi.doUnmock('@opencode-ai/sdk/v2');
  });

  it('should fall back to default provider/model from providers list', async () => {
    const mock = mockSdk({
      configModel: undefined,
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          models: { 'gpt-4o': { name: 'GPT-4o' } },
        },
      ],
      defaultMap: { chat: 'openai/gpt-4o' },
    });
    vi.doMock('@opencode-ai/sdk/v2', () => mock);

    const { validateOpenCode: validate } = await import('./llm-analyzer.js');
    const result = await validate();

    expect(result.activeModel).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(result.availableModels).toEqual([{ provider: 'openai', model: 'gpt-4o' }]);
    expect(mock.serverClose).toHaveBeenCalled();

    vi.doUnmock('@opencode-ai/sdk/v2');
  });

  it('should use first provider model when default is just a provider ID', async () => {
    const mock = mockSdk({
      configModel: undefined,
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: {
            'claude-sonnet-4-20250514': { name: 'Claude Sonnet' },
            'claude-haiku-4-20250414': { name: 'Claude Haiku' },
          },
        },
      ],
      defaultMap: { chat: 'anthropic' },
    });
    vi.doMock('@opencode-ai/sdk/v2', () => mock);

    const { validateOpenCode: validate } = await import('./llm-analyzer.js');
    const result = await validate();

    expect(result.activeModel.provider).toBe('anthropic');
    expect(result.activeModel.model).toBeTruthy();
    expect(result.availableModels).toHaveLength(2);
    expect(mock.serverClose).toHaveBeenCalled();

    vi.doUnmock('@opencode-ai/sdk/v2');
  });

  it('should return all available models across providers', async () => {
    const mock = mockSdk({
      configModel: undefined,
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: { 'claude-sonnet-4-20250514': { name: 'Claude Sonnet' } },
        },
        {
          id: 'openai',
          name: 'OpenAI',
          models: { 'gpt-4o': { name: 'GPT-4o' } },
        },
      ],
      defaultMap: { chat: 'anthropic/claude-sonnet-4-20250514' },
    });
    vi.doMock('@opencode-ai/sdk/v2', () => mock);

    const { validateOpenCode: validate } = await import('./llm-analyzer.js');
    const result = await validate();

    expect(result.availableModels).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      { provider: 'openai', model: 'gpt-4o' },
    ]);
    expect(mock.serverClose).toHaveBeenCalled();

    vi.doUnmock('@opencode-ai/sdk/v2');
  });

  it('should throw when no providers are configured', async () => {
    const mock = mockSdk({
      configModel: undefined,
      providers: [],
      defaultMap: {},
    });
    vi.doMock('@opencode-ai/sdk/v2', () => mock);

    const { validateOpenCode: validate } = await import('./llm-analyzer.js');

    await expect(validate()).rejects.toThrow('No LLM providers configured');
    expect(mock.serverClose).toHaveBeenCalled();

    vi.doUnmock('@opencode-ai/sdk/v2');
  });

  it('should always close the server even on error', async () => {
    const serverClose = vi.fn();
    const createOpencode = vi.fn().mockResolvedValue({
      client: {
        config: {
          get: vi.fn(),
          providers: vi.fn().mockRejectedValue(new Error('connection failed')),
        },
      },
      server: { close: serverClose },
    });
    vi.doMock('@opencode-ai/sdk/v2', () => ({ createOpencode }));

    const { validateOpenCode: validate } = await import('./llm-analyzer.js');

    await expect(validate()).rejects.toThrow('connection failed');
    expect(serverClose).toHaveBeenCalled();

    vi.doUnmock('@opencode-ai/sdk/v2');
  });
});
