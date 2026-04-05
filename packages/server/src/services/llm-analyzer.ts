import type {
  LlmAnalysisResult,
  LlmChunkAssignment,
  LlmModelInfo,
  Priority,
} from '@pr-review/shared';
import type Database from 'better-sqlite3';
import type { ParsedFileDiff } from './diff-parser.js';

/**
 * Validate that the OpenCode SDK is available and correctly configured.
 * Spins up a temporary OpenCode instance, queries the active model,
 * and returns the provider + model name.
 *
 * @throws {Error} if the SDK is not installed or no provider is configured
 */
export async function validateOpenCode(): Promise<LlmModelInfo> {
  // 1. Check that the SDK can be imported
  let createOpencode: (opts: { port: number }) => Promise<{
    client: {
      config: {
        get: () => Promise<{ data?: { model?: string } }>;
        providers: () => Promise<{
          data?: {
            providers: Array<{
              id: string;
              name: string;
              models: Record<string, { name: string }>;
            }>;
            default: Record<string, string>;
          };
        }>;
      };
    };
    server: { close: () => void };
  }>;

  try {
    const sdk = await import('@opencode-ai/sdk/v2');
    createOpencode = sdk.createOpencode;
  } catch {
    throw new Error(
      'OpenCode SDK is not installed. Install it with:\n  npm install @opencode-ai/sdk',
    );
  }

  // 2. Spin up a temporary instance and query the config
  const { client, server } = await createOpencode({ port: 0 });
  try {
    // Check config for explicit model override
    const configResult = await client.config.get();
    const configModel = configResult.data?.model;

    if (configModel) {
      // Config model is typically "provider/model" format
      const slashIdx = configModel.indexOf('/');
      if (slashIdx > 0) {
        return {
          provider: configModel.substring(0, slashIdx),
          model: configModel.substring(slashIdx + 1),
        };
      }
    }

    // Fall back to providers list to find the default
    const providersResult = await client.config.providers();
    const providersData = providersResult.data;

    if (!providersData || providersData.providers.length === 0) {
      throw new Error(
        'No LLM providers configured in OpenCode.\n' +
          'Configure a provider (e.g. Anthropic, OpenAI) in your OpenCode config:\n' +
          '  ~/.config/opencode/config.json',
      );
    }

    // The default map contains entries like { "chat": "anthropic" } mapping to provider IDs
    // Find the first provider with models available
    const defaults = providersData.default;
    const defaultProviderKey = defaults.chat ?? defaults.code ?? Object.values(defaults)[0];

    if (defaultProviderKey) {
      // defaultProviderKey might be "provider/model" or just "provider"
      const slashIdx = defaultProviderKey.indexOf('/');
      if (slashIdx > 0) {
        return {
          provider: defaultProviderKey.substring(0, slashIdx),
          model: defaultProviderKey.substring(slashIdx + 1),
        };
      }

      // It's just a provider ID — find the first model in that provider
      const provider = providersData.providers.find((p) => p.id === defaultProviderKey);
      if (provider) {
        const modelIds = Object.keys(provider.models);
        if (modelIds.length > 0) {
          return { provider: provider.id, model: modelIds[0] };
        }
      }
    }

    // Last resort: use the first provider's first model
    const firstProvider = providersData.providers[0];
    const firstModelId = Object.keys(firstProvider.models)[0];
    if (firstModelId) {
      return { provider: firstProvider.id, model: firstModelId };
    }

    throw new Error(
      'No models available in any configured provider.\n' +
        'Check your API keys and provider configuration in:\n' +
        '  ~/.config/opencode/config.json',
    );
  } finally {
    server.close();
  }
}

export interface LlmAnalyzerOptions {
  db: Database.Database;
  repoPath: string;
}

/**
 * JSON Schema for the LLM structured output.
 * Defines the expected shape of the analysis response.
 */
export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    pr_summary: {
      type: 'string',
      description: 'A concise 2-3 sentence summary of the overall PR changes and their purpose.',
    },
    suggested_tags: {
      type: 'array',
      description:
        'Additional PR-specific tags beyond the defaults. Only suggest tags that are genuinely useful for grouping.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Kebab-case tag name' },
          description: { type: 'string', description: 'Brief description of what this tag means' },
          color: {
            type: 'string',
            description: 'Hex color code for the tag (e.g. #3b82f6)',
          },
        },
        required: ['name', 'description', 'color'],
      },
    },
    chunk_assignments: {
      type: 'array',
      description: 'Tag and priority assignments for each diff chunk.',
      items: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path from the diff' },
          chunk_index: {
            type: 'integer',
            description: 'Zero-based index of the chunk within the file',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Tags to assign. Use default tags (bug-fix, refactor, new-feature, style/formatting, tests, docs, config, security, performance, needs-discussion) and any suggested_tags.',
          },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description:
              'Review priority. high = needs careful review, medium = normal, low = routine/trivial',
          },
          review_note: {
            type: ['string', 'null'],
            description:
              'Brief note for the reviewer. Only set for high-priority chunks or chunks that need special attention. null otherwise.',
          },
        },
        required: ['file_path', 'chunk_index', 'tags', 'priority', 'review_note'],
      },
    },
  },
  required: ['pr_summary', 'suggested_tags', 'chunk_assignments'],
} as const;

/**
 * Build the analysis prompt for the LLM.
 */
export function buildAnalysisPrompt(
  prTitle: string,
  prBody: string,
  prAuthor: string,
  baseBranch: string,
  fileDiffs: ParsedFileDiff[],
): string {
  const chunkSummary = fileDiffs
    .map((fd) => {
      const chunkList = fd.chunks
        .map((c) => `    chunk ${c.chunkIndex}: lines ${c.startLine}-${c.endLine}`)
        .join('\n');
      return `  ${fd.status.toUpperCase()} ${fd.filePath}${fd.oldPath ? ` (was: ${fd.oldPath})` : ''}\n${chunkList}`;
    })
    .join('\n');

  const diffContent = fileDiffs
    .map((fd) => {
      const header = `=== ${fd.status.toUpperCase()}: ${fd.filePath} ===`;
      const chunks = fd.chunks
        .map((c) => `--- chunk ${c.chunkIndex} ---\n${c.diffText}`)
        .join('\n\n');
      return `${header}\n${chunks}`;
    })
    .join('\n\n');

  return `You are a senior code reviewer analyzing a pull request. Your job is to categorize and prioritize each diff chunk for review.

## PR Metadata
- **Title:** ${prTitle}
- **Author:** ${prAuthor}
- **Base branch:** ${baseBranch}
- **Description:** ${prBody || '(no description)'}

## Files and Chunks Overview
${chunkSummary}

## Available Default Tags
bug-fix, refactor, new-feature, style/formatting, tests, docs, config, security, performance, needs-discussion

## Full Diff
${diffContent}

## Instructions
1. Write a concise PR summary (2-3 sentences).
2. Suggest any additional PR-specific tags if the defaults don't adequately cover the change types. Don't suggest tags that overlap with defaults.
3. For EVERY chunk listed above, assign:
   - One or more tags (from defaults + your suggestions)
   - A priority (high/medium/low) based on review importance
   - A review_note ONLY for high-priority chunks or chunks needing special attention (null otherwise)

Be precise with file_path and chunk_index — they must match exactly.`;
}

/**
 * Analyze PR chunks using OpenCode SDK with structured output.
 *
 * Creates an OpenCode session, sends the analysis prompt with the full diff,
 * and returns structured tag/priority assignments for each chunk.
 */
export async function analyzePr(
  options: LlmAnalyzerOptions,
  prId: number,
  prTitle: string,
  prBody: string,
  prAuthor: string,
  baseBranch: string,
  fileDiffs: ParsedFileDiff[],
): Promise<LlmAnalysisResult> {
  const { db } = options;

  // Record the LLM run
  const run = db
    .prepare("INSERT INTO llm_runs (pr_id, status) VALUES (?, 'running') RETURNING id")
    .get(prId) as { id: number };

  try {
    // Dynamic import to avoid hard dependency when SDK isn't available
    const { createOpencode } = await import('@opencode-ai/sdk/v2');

    const { client, server } = await createOpencode({ port: 0 });

    try {
      // Create a session for this analysis
      const sessionResult = await client.session.create({
        title: `PR #${prId} Analysis`,
      });

      const session = sessionResult.data;
      if (!session) {
        throw new Error('Failed to create OpenCode session');
      }

      // Build the prompt
      const prompt = buildAnalysisPrompt(prTitle, prBody, prAuthor, baseBranch, fileDiffs);

      // Send prompt with structured output
      const response = await client.session.prompt({
        sessionID: session.id,
        parts: [{ type: 'text', text: prompt }],
        format: {
          type: 'json_schema',
          schema: ANALYSIS_SCHEMA,
          retryCount: 2,
        },
      });

      // Check for errors
      const data = response.data;
      if (!data) {
        throw new Error('No response data from LLM');
      }

      if (data.info.error) {
        const errName = data.info.error.name;
        const errData = data.info.error.data;
        throw new Error(`LLM error (${errName}): ${JSON.stringify(errData)}`);
      }

      // Parse the structured output
      const structured = data.info.structured as RawAnalysisResult | undefined;
      if (!structured) {
        throw new Error('No structured output returned from LLM');
      }

      const result = mapAnalysisResult(structured);

      // Update run status
      db.prepare(
        "UPDATE llm_runs SET status = 'completed', finished_at = datetime('now'), summary = ? WHERE id = ?",
      ).run(result.prSummary, run.id);

      // Store chunk metadata
      storeChunkMetadata(db, prId, run.id, result.chunkAssignments);

      return result;
    } finally {
      server.close();
    }
  } catch (error) {
    // Mark run as failed
    const msg = error instanceof Error ? error.message : String(error);
    db.prepare(
      "UPDATE llm_runs SET status = 'failed', finished_at = datetime('now'), summary = ? WHERE id = ?",
    ).run(`Error: ${msg}`, run.id);
    throw error;
  }
}

// ── Internal Types ──────────────────────────────────────────

interface RawAnalysisResult {
  pr_summary: string;
  suggested_tags: Array<{
    name: string;
    description: string;
    color: string;
  }>;
  chunk_assignments: Array<{
    file_path: string;
    chunk_index: number;
    tags: string[];
    priority: string;
    review_note: string | null;
  }>;
}

// ── Helpers ─────────────────────────────────────────────────

function mapAnalysisResult(raw: RawAnalysisResult): LlmAnalysisResult {
  return {
    prSummary: raw.pr_summary,
    suggestedTags: raw.suggested_tags.map((t) => ({
      name: t.name,
      description: t.description,
      color: t.color,
    })),
    chunkAssignments: raw.chunk_assignments.map((a) => ({
      filePath: a.file_path,
      chunkIndex: a.chunk_index,
      tags: a.tags,
      priority: validatePriority(a.priority),
      reviewNote: a.review_note,
    })),
  };
}

function validatePriority(p: string): Priority {
  if (p === 'high' || p === 'medium' || p === 'low') return p;
  return 'medium';
}

function storeChunkMetadata(
  db: Database.Database,
  prId: number,
  llmRunId: number,
  assignments: LlmChunkAssignment[],
): void {
  const getChunk = db.prepare(
    'SELECT id FROM chunks WHERE pr_id = ? AND file_path = ? AND chunk_index = ?',
  );

  const upsertMetadata = db.prepare(`
    INSERT INTO chunk_metadata (chunk_id, priority, review_note, llm_run_id)
    VALUES (@chunkId, @priority, @reviewNote, @llmRunId)
    ON CONFLICT (chunk_id) DO UPDATE SET
      priority = @priority,
      review_note = @reviewNote,
      llm_run_id = @llmRunId
  `);

  const getOrCreateTag = db.prepare(`
    INSERT INTO tags (name, description, color, is_default)
    VALUES (@name, @description, @color, 0)
    ON CONFLICT (name) DO UPDATE SET name = name
    RETURNING id
  `);

  const insertChunkTag = db.prepare(`
    INSERT OR IGNORE INTO chunk_tags (chunk_id, tag_id) VALUES (?, ?)
  `);

  const clearChunkTags = db.prepare('DELETE FROM chunk_tags WHERE chunk_id = ?');

  const store = db.transaction(() => {
    for (const assignment of assignments) {
      const chunk = getChunk.get(prId, assignment.filePath, assignment.chunkIndex) as
        | { id: number }
        | undefined;

      if (!chunk) continue;

      // Upsert metadata
      upsertMetadata.run({
        chunkId: chunk.id,
        priority: assignment.priority,
        reviewNote: assignment.reviewNote,
        llmRunId,
      });

      // Clear existing tags and re-assign
      clearChunkTags.run(chunk.id);

      for (const tagName of assignment.tags) {
        const tag = getOrCreateTag.get({
          name: tagName,
          description: '',
          color: '#6b7280',
        }) as { id: number };

        insertChunkTag.run(chunk.id, tag.id);
      }
    }
  });

  store();
}
