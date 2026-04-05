import { describe, expect, it, vi } from 'vitest';
import type { ParsedFileDiff } from './diff-parser.js';
import { buildAnalysisPrompt } from './llm-analyzer.js';

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
  it('should include PR metadata', () => {
    const prompt = buildAnalysisPrompt(
      'Add inline types',
      'This PR adds type annotations.',
      'nateprewitt',
      'main',
      SAMPLE_FILE_DIFFS,
    );

    expect(prompt).toContain('Add inline types');
    expect(prompt).toContain('nateprewitt');
    expect(prompt).toContain('main');
    expect(prompt).toContain('This PR adds type annotations.');
  });

  it('should include all file paths', () => {
    const prompt = buildAnalysisPrompt('Title', 'Body', 'author', 'main', SAMPLE_FILE_DIFFS);

    expect(prompt).toContain('src/requests/utils.py');
    expect(prompt).toContain('src/requests/_types.py');
  });

  it('should include file status', () => {
    const prompt = buildAnalysisPrompt('Title', 'Body', 'author', 'main', SAMPLE_FILE_DIFFS);

    expect(prompt).toContain('MODIFIED src/requests/utils.py');
    expect(prompt).toContain('ADDED src/requests/_types.py');
  });

  it('should include chunk indices and line ranges', () => {
    const prompt = buildAnalysisPrompt('Title', 'Body', 'author', 'main', SAMPLE_FILE_DIFFS);

    expect(prompt).toContain('chunk 0: lines 10-16');
    expect(prompt).toContain('chunk 1: lines 46-52');
  });

  it('should include diff content', () => {
    const prompt = buildAnalysisPrompt('Title', 'Body', 'author', 'main', SAMPLE_FILE_DIFFS);

    expect(prompt).toContain('+from typing import Optional');
    expect(prompt).toContain('+"""Types module."""');
  });

  it('should list default tags', () => {
    const prompt = buildAnalysisPrompt('Title', 'Body', 'author', 'main', SAMPLE_FILE_DIFFS);

    expect(prompt).toContain('bug-fix');
    expect(prompt).toContain('refactor');
    expect(prompt).toContain('new-feature');
    expect(prompt).toContain('needs-discussion');
  });

  it('should handle empty body', () => {
    const prompt = buildAnalysisPrompt('Title', '', 'author', 'main', SAMPLE_FILE_DIFFS);

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

    const prompt = buildAnalysisPrompt('Title', 'Body', 'author', 'main', diffs);
    expect(prompt).toContain('RENAMED new_name.py (was: old_name.py)');
  });
});

describe('ANALYSIS_SCHEMA', () => {
  it('should be a valid JSON schema shape', async () => {
    const { ANALYSIS_SCHEMA } = await import('./llm-analyzer.js');

    expect(ANALYSIS_SCHEMA.type).toBe('object');
    expect(ANALYSIS_SCHEMA.required).toContain('pr_summary');
    expect(ANALYSIS_SCHEMA.required).toContain('suggested_tags');
    expect(ANALYSIS_SCHEMA.required).toContain('chunk_assignments');
    expect(ANALYSIS_SCHEMA.properties.chunk_assignments.type).toBe('array');
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
