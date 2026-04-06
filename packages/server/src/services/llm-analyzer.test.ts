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
