import type {
  LlmAnalysisResult,
  LlmChunkAssignment,
  LlmModelInfo,
  LlmTagDefinition,
  LlmTagSummary,
  Priority,
} from '@pr-review/shared';
import type Database from 'better-sqlite3';
import type { ParsedFileDiff } from './diff-parser.js';

/**
 * Result of validating OpenCode SDK configuration.
 * Contains the active model and a list of all available models for discoverability.
 */
export interface OpenCodeValidation {
  activeModel: LlmModelInfo;
  availableModels: LlmModelInfo[];
}

/**
 * Validate that the OpenCode SDK is available and correctly configured.
 * Spins up a temporary OpenCode instance, queries the active model,
 * and returns the provider + model name along with all available models.
 *
 * @throws {Error} if the SDK is not installed or no provider is configured
 */
export async function validateOpenCode(): Promise<OpenCodeValidation> {
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
    // Always query providers to build the available models list
    const providersResult = await client.config.providers();
    const providersData = providersResult.data;

    if (!providersData || providersData.providers.length === 0) {
      throw new Error(
        'No LLM providers configured in OpenCode.\n' +
          'Configure a provider (e.g. Anthropic, OpenAI) in your OpenCode config:\n' +
          '  ~/.config/opencode/config.json',
      );
    }

    // Collect all available models across all providers
    const availableModels: LlmModelInfo[] = [];
    for (const provider of providersData.providers) {
      for (const modelId of Object.keys(provider.models)) {
        availableModels.push({ provider: provider.id, model: modelId });
      }
    }

    if (availableModels.length === 0) {
      throw new Error(
        'No models available in any configured provider.\n' +
          'Check your API keys and provider configuration in:\n' +
          '  ~/.config/opencode/config.json',
      );
    }

    // Determine the active model: check config override first, then defaults
    const configResult = await client.config.get();
    const configModel = configResult.data?.model;

    if (configModel) {
      const slashIdx = configModel.indexOf('/');
      if (slashIdx > 0) {
        return {
          activeModel: {
            provider: configModel.substring(0, slashIdx),
            model: configModel.substring(slashIdx + 1),
          },
          availableModels,
        };
      }
    }

    // Fall back to the default map from providers
    const defaults = providersData.default;
    const defaultProviderKey = defaults.chat ?? defaults.code ?? Object.values(defaults)[0];

    if (defaultProviderKey) {
      const slashIdx = defaultProviderKey.indexOf('/');
      if (slashIdx > 0) {
        return {
          activeModel: {
            provider: defaultProviderKey.substring(0, slashIdx),
            model: defaultProviderKey.substring(slashIdx + 1),
          },
          availableModels,
        };
      }

      // It's just a provider ID — find the first model in that provider
      const provider = providersData.providers.find((p) => p.id === defaultProviderKey);
      if (provider) {
        const modelIds = Object.keys(provider.models);
        if (modelIds.length > 0) {
          return {
            activeModel: { provider: provider.id, model: modelIds[0] },
            availableModels,
          };
        }
      }
    }

    // Last resort: use the first available model
    return { activeModel: availableModels[0], availableModels };
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
      description:
        'A thorough markdown-formatted summary of what was changed. Describe the areas of the codebase affected, the logical order of changes, and their purpose. Use markdown formatting (bold, lists, etc.) for readability.',
    },
    tags: {
      type: 'array',
      description:
        'ALL tags you will use for chunk assignments. Define every tag before referencing it in chunk_assignments. Make functionality tags very specific to this PR.',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Kebab-case tag name, specific to this PR',
          },
          description: {
            type: 'string',
            description: 'Brief description of what this tag covers',
          },
        },
        required: ['name', 'description'],
      },
    },
    chunk_assignments: {
      type: 'array',
      description:
        'Tag and priority assignments for each diff chunk. Every chunk must be assigned at least one tag.',
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
              'Tags to assign from the tags array. Assign from multiple dimensions when applicable.',
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
              'Brief markdown-formatted note for the reviewer. Only set for high-priority chunks or chunks that need special attention. null otherwise.',
          },
        },
        required: ['file_path', 'chunk_index', 'tags', 'priority', 'review_note'],
      },
    },
    tag_summaries: {
      type: 'array',
      description:
        'A summary for each tag, describing the specific code changes in that group, where they happened, the logical flow, and their purpose.',
      items: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description: 'Tag name (must match a tag used in chunk_assignments)',
          },
          summary: {
            type: 'string',
            description:
              'A markdown-formatted summary describing the specific code changes in this group, which files/functions were modified, the logical flow of changes, and their purpose.',
          },
        },
        required: ['tag', 'summary'],
      },
    },
  },
  required: ['pr_summary', 'tags', 'chunk_assignments', 'tag_summaries'],
} as const;

/**
 * Build the analysis prompt for the LLM.
 */
export function buildAnalysisPrompt(
  prTitle: string,
  prBody: string,
  prAuthor: string,
  baseBranch: string,
  headBranch: string,
  commitMessages: string[],
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

  const commitSection =
    commitMessages.length > 0 ? commitMessages.map((m) => `- ${m}`).join('\n') : '(no commits)';

  return `You are a senior code reviewer helping a human reviewer understand a pull request.

Your purpose is to split this change into different aspects — like a prism splitting light —
so the reviewer can examine each dimension of the change independently. Good tagging helps
the reviewer focus on one concern at a time (e.g., all the database changes, then all the
validation logic, then the tests) rather than reviewing files linearly.

Use the commit messages, branch name, and PR description to understand the intent and context
behind the changes. If the diff references functions, classes, or patterns that suggest a
broader context (e.g., a migration pattern, a specific domain concept), factor that into
your tagging — name tags after the actual domain concepts you see in the code.

## PR Metadata
- **Title:** ${prTitle}
- **Author:** ${prAuthor}
- **Source branch:** ${headBranch}
- **Base branch:** ${baseBranch}
- **Description:** ${prBody || '(no description)'}

## Commit History
${commitSection}

## Files and Chunks Overview
${chunkSummary}

## Full Diff
${diffContent}

## Tag Taxonomy

Create tags for each chunk based on these dimensions. All tag names are yours to define —
use the examples below as inspiration, but make tags specific to what you see in this PR's code.

### Layer (what part of the stack is being changed)
Examples: database, caching, service, controller, api-client, api-server, cli, reporting, logging

### Functionality (what specifically is being changed)
Name the tag after the specific feature, fix, or behavior — not a generic category.
Good examples: "birthdate-validation-fix", "trade-attributes-caching", "user-session-timeout-increase"
Bad examples: "bugfix", "logic-change", "validation-fix", "feature"

### Repo-wide changes
Examples: refactoring, rename, style/formatting

### Category
Examples: tests, docs, config, security, performance, ci-cd, kubernetes, agent-files,
dependencies, packaging

Not every dimension applies to every chunk. Assign tags from multiple dimensions when applicable.

## Instructions

1. **PR Summary**: Write a thorough summary of what was changed. Describe the areas of the
   codebase affected, the logical order of changes, and their purpose. Cover both the "what"
   and the "why".

2. **Define Tags**: Define ALL tags you will use. Each tag needs a short name (kebab-case) and
   a brief description. Make functionality tags very specific to this PR — name them after the
   domain concepts, features, or behaviors you see in the code.

3. **Assign Chunks**: For EVERY chunk listed above, assign:
   - One or more tags (from the tags you defined in step 2)
   - A priority (high/medium/low) based on review importance
   - A review_note ONLY for high-priority chunks or chunks needing special attention (null otherwise)
   Every chunk MUST receive at least one tag. Do not skip any chunks.

4. **Tag Summaries**: For EACH tag you assigned to at least one chunk, write a summary of a few
   sentences describing the specific code changes in this group, where they happened (which
   files/functions), the logical flow of the changes, and their purpose.

## Formatting

All text fields (pr_summary, review_note, tag summaries) are rendered as **markdown**.
Use markdown formatting for readability:
- **Bold** for emphasis on key terms, file names, or concepts
- Numbered lists for sequential items or multiple distinct changes
- Bullet lists for related points
- \`inline code\` for function names, variable names, file paths, and code references

Be precise with file_path and chunk_index — they must match the overview exactly.`;
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
  headBranch: string,
  commitMessages: string[],
  fileDiffs: ParsedFileDiff[],
  modelOverride?: LlmModelInfo,
): Promise<LlmAnalysisResult> {
  const { db } = options;

  // Record the LLM run
  const run = db
    .prepare("INSERT INTO llm_runs (pr_id, status) VALUES (?, 'running') RETURNING id")
    .get(prId) as { id: number };

  try {
    // Dynamic import to avoid hard dependency when SDK isn't available
    const { createOpencode } = await import('@opencode-ai/sdk/v2');

    const totalChunks = fileDiffs.reduce((sum, fd) => sum + fd.chunks.length, 0);
    console.log(`[analyze] Starting analysis: ${fileDiffs.length} files, ${totalChunks} chunks`);

    console.log('[analyze] Spinning up OpenCode instance...');
    const { client, server } = await createOpencode({ port: 0 });

    try {
      // Create a session for this analysis
      console.log('[analyze] Creating session...');
      const sessionResult = await client.session.create({
        title: `PR #${prId} Analysis`,
      });

      const session = sessionResult.data;
      if (!session) {
        throw new Error('Failed to create OpenCode session');
      }

      // Build the prompt
      const prompt = buildAnalysisPrompt(
        prTitle,
        prBody,
        prAuthor,
        baseBranch,
        headBranch,
        commitMessages,
        fileDiffs,
      );
      const promptKb = Math.round(Buffer.byteLength(prompt, 'utf8') / 1024);
      const model = modelOverride ? `${modelOverride.provider}/${modelOverride.model}` : 'default';
      console.log(`[analyze] Sending prompt (${promptKb} KB) to ${model}...`);

      if (process.env.DEBUG_LLM_PROMPT) {
        console.log('[analyze] ─── LLM PROMPT START ───');
        console.log(prompt);
        console.log('[analyze] ─── LLM PROMPT END ───');
      }

      // Send prompt with structured output
      const startTime = Date.now();
      const response = await client.session.prompt({
        sessionID: session.id,
        parts: [{ type: 'text', text: prompt }],
        ...(modelOverride && {
          model: { providerID: modelOverride.provider, modelID: modelOverride.model },
        }),
        format: {
          type: 'json_schema',
          schema: ANALYSIS_SCHEMA,
          retryCount: 2,
        },
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[analyze] LLM responded in ${elapsed}s`);

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

      // Store chunk metadata and tags
      storeChunkMetadata(db, prId, run.id, result.chunkAssignments, result.tags);

      // Store tag summaries
      storeTagSummaries(db, prId, run.id, result.tagSummaries);

      console.log(
        `[analyze] Done: ${result.chunkAssignments.length} chunks tagged, ${result.tags.length} tags defined, ${result.tagSummaries.length} tag summaries`,
      );

      return result;
    } finally {
      server.close();
    }
  } catch (error) {
    // Mark run as failed
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[analyze] Failed: ${msg}`);
    db.prepare(
      "UPDATE llm_runs SET status = 'failed', finished_at = datetime('now'), summary = ? WHERE id = ?",
    ).run(`Error: ${msg}`, run.id);
    throw error;
  }
}

// ── Internal Types ──────────────────────────────────────────

interface RawAnalysisResult {
  pr_summary: string;
  tags: Array<{
    name: string;
    description: string;
  }>;
  chunk_assignments: Array<{
    file_path: string;
    chunk_index: number;
    tags: string[];
    priority: string;
    review_note: string | null;
  }>;
  tag_summaries: Array<{
    tag: string;
    summary: string;
  }>;
}

// ── Helpers ─────────────────────────────────────────────────

function mapAnalysisResult(raw: RawAnalysisResult): LlmAnalysisResult {
  return {
    prSummary: raw.pr_summary,
    tags: raw.tags.map((t) => ({
      name: t.name,
      description: t.description,
    })),
    chunkAssignments: raw.chunk_assignments.map((a) => ({
      filePath: a.file_path,
      chunkIndex: a.chunk_index,
      tags: a.tags,
      priority: validatePriority(a.priority),
      reviewNote: a.review_note,
    })),
    tagSummaries: (raw.tag_summaries ?? []).map((ts) => ({
      tag: ts.tag,
      summary: ts.summary,
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
  tagDefinitions: LlmTagDefinition[],
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
    INSERT INTO tags (name, description, pr_id)
    VALUES (@name, @description, @prId)
    ON CONFLICT (name, pr_id) DO UPDATE SET description = @description
    RETURNING id
  `);

  const insertChunkTag = db.prepare(`
    INSERT OR IGNORE INTO chunk_tags (chunk_id, tag_id) VALUES (?, ?)
  `);

  const clearChunkTags = db.prepare('DELETE FROM chunk_tags WHERE chunk_id = ?');

  // Build a lookup from tag name to description from LLM definitions
  const tagDescriptions = new Map<string, string>();
  for (const td of tagDefinitions) {
    tagDescriptions.set(td.name, td.description);
  }

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
          description: tagDescriptions.get(tagName) ?? '',
          prId,
        }) as { id: number };

        insertChunkTag.run(chunk.id, tag.id);
      }
    }

    // Assign 'unassigned' tag to any chunks that have no tags
    const untaggedChunks = db
      .prepare(
        `SELECT c.id FROM chunks c
         WHERE c.pr_id = ?
           AND c.id NOT IN (SELECT chunk_id FROM chunk_tags)`,
      )
      .all(prId) as Array<{ id: number }>;

    if (untaggedChunks.length > 0) {
      const unassignedTag = getOrCreateTag.get({
        name: 'unassigned',
        description: 'Chunks not categorized by LLM analysis',
        prId,
      }) as { id: number };

      for (const chunk of untaggedChunks) {
        insertChunkTag.run(chunk.id, unassignedTag.id);
      }

      console.log(
        `[analyze] Assigned 'unassigned' tag to ${untaggedChunks.length} chunks without tags`,
      );
    }
  });

  store();
}

function storeTagSummaries(
  db: Database.Database,
  prId: number,
  llmRunId: number,
  tagSummaries: LlmTagSummary[],
): void {
  if (tagSummaries.length === 0) return;

  const getTagId = db.prepare('SELECT id FROM tags WHERE name = ? AND pr_id = ?');

  const upsertSummary = db.prepare(`
    INSERT INTO tag_summaries (pr_id, tag_id, summary, llm_run_id)
    VALUES (@prId, @tagId, @summary, @llmRunId)
    ON CONFLICT (pr_id, tag_id) DO UPDATE SET
      summary = @summary,
      llm_run_id = @llmRunId
  `);

  const store = db.transaction(() => {
    for (const ts of tagSummaries) {
      const tag = getTagId.get(ts.tag, prId) as { id: number } | undefined;
      if (!tag) continue;

      upsertSummary.run({
        prId,
        tagId: tag.id,
        summary: ts.summary,
        llmRunId,
      });
    }
  });

  store();
}
