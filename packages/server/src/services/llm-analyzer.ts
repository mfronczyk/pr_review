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
 * JSON Schema for Phase 1: Tag discovery and chunk assignment.
 * The LLM assigns tags and priorities but generates no summaries.
 */
export const TAGGING_SCHEMA = {
  type: 'object',
  properties: {
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
  },
  required: ['tags', 'chunk_assignments'],
} as const;

/**
 * JSON Schema for Phase 2: Tag summary generation.
 * Each call generates a summary for a single tag group.
 */
export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'A markdown-formatted summary describing the specific code changes in this tag group, which files/functions were modified, the logical flow of changes, and their purpose. If any chunks deserve extra attention, end with a note on what the reviewer should watch for.',
    },
  },
  required: ['summary'],
} as const;

/**
 * Build the system prompt for Phase 1 — tag discovery and chunk assignment.
 * This overrides OpenCode's default system prompt so the LLM acts as a PR reviewer,
 * not a coding agent.
 */
export function buildTaggingSystemPrompt(): string {
  return `You are a senior code reviewer helping a human reviewer understand a pull request.

Your purpose is to split this change into different aspects — like a prism splitting light —
so the reviewer can examine each dimension of the change independently. Good tagging helps
the reviewer focus on one concern at a time (e.g., all the database changes, then all the
validation logic, then the tests) rather than reviewing files linearly.

Use the commit messages, branch name, and PR description to understand the intent and context
behind the changes. If the diff references functions, classes, or patterns that suggest a
broader context (e.g., a migration pattern, a specific domain concept), factor that into
your tagging — name tags after the actual domain concepts you see in the code.

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

1. **Define Tags**: Define ALL tags you will use. Each tag needs a short name (kebab-case) and
   a brief description. Make functionality tags very specific to this PR — name them after the
   domain concepts, features, or behaviors you see in the code.

2. **Assign Chunks**: For EVERY chunk in the diff, assign:
   - One or more tags (from the tags you defined in step 1)
   - A priority (high/medium/low) based on review importance
   - A review_note ONLY for high-priority chunks or chunks needing special attention (null otherwise)
   Every chunk MUST receive at least one tag. Do not skip any chunks.

## Formatting

The review_note field is rendered as **markdown**. Use markdown formatting for readability:
- **Bold** for emphasis on key terms, file names, or concepts
- \`inline code\` for function names, variable names, file paths, and code references

Be precise with file_path and chunk_index — they must match the diff exactly.`;
}

/**
 * Build the system prompt for Phase 2 — tag summary generation.
 */
export function buildSummarySystemPrompt(): string {
  return `You are a senior code reviewer writing a summary for a group of related code changes in a pull request. The changes have been grouped by a specific tag/aspect. Your summary should help a reviewer quickly understand what happened in this group.

Write a concise markdown-formatted summary covering:
- What specific code changes were made and where (files/functions)
- The logical flow and purpose of the changes
- If any chunks deserve extra attention, what the reviewer should watch for (e.g. edge cases, error handling gaps, performance implications)

Use \`inline code\` for function names, variable names, and file paths. Use **bold** for emphasis. Keep it focused and actionable.`;
}

/**
 * Build the user prompt for Phase 2 — summarize a single tag group.
 */
export function buildSummaryPrompt(
  tagName: string,
  tagDescription: string,
  chunks: Array<{ filePath: string; chunkIndex: number; diffText: string }>,
  prTitle: string,
  prBody: string,
): string {
  const chunkContent = chunks
    .map((c) => `=== ${c.filePath} chunk ${c.chunkIndex} ===\n${c.diffText}`)
    .join('\n\n');

  return `## Tag: ${tagName}
**Description:** ${tagDescription}

## PR Context
- **Title:** ${prTitle}
- **Description:** ${prBody || '(no description)'}

## Chunks in this group
${chunkContent}

Write a summary for this tag group.`;
}

/**
 * Build the user prompt — PR metadata, commit history, and full diff content.
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
  const diffContent = fileDiffs
    .map((fd) => {
      const renamed = fd.oldPath ? ` (was: ${fd.oldPath})` : '';
      const header = `=== ${fd.status.toUpperCase()}: ${fd.filePath}${renamed} ===`;
      const chunks = fd.chunks
        .map((c) => `--- chunk ${c.chunkIndex} ---\n${c.diffText}`)
        .join('\n\n');
      return `${header}\n${chunks}`;
    })
    .join('\n\n');

  const commitSection =
    commitMessages.length > 0 ? commitMessages.map((m) => `- ${m}`).join('\n') : '(no commits)';

  return `## PR Metadata
- **Title:** ${prTitle}
- **Author:** ${prAuthor}
- **Source branch:** ${headBranch}
- **Base branch:** ${baseBranch}
- **Description:** ${prBody || '(no description)'}

## Commit History
${commitSection}

## Full Diff
${diffContent}

Analyze this pull request. Define tags and assign every chunk.`;
}

/**
 * Build a self-contained prompt for manual LLM analysis via VS Code Copilot Chat.
 *
 * Merges the system prompt, JSON output format instructions (with a concrete example),
 * and the full PR diff into a single text that the user can paste into any LLM chat UI.
 * The LLM should respond with raw JSON matching the RawTaggingResult shape.
 */
export function buildExportablePrompt(
  prTitle: string,
  prBody: string,
  prAuthor: string,
  baseBranch: string,
  headBranch: string,
  commitMessages: string[],
  fileDiffs: ParsedFileDiff[],
): string {
  const systemPrompt = buildTaggingSystemPrompt();
  const userPrompt = buildAnalysisPrompt(
    prTitle,
    prBody,
    prAuthor,
    baseBranch,
    headBranch,
    commitMessages,
    fileDiffs,
  );

  return `${systemPrompt}

## Output Format

Respond with ONLY a JSON object. No markdown code fences, no commentary, no explanation.
The JSON must have this exact structure:

{
  "tags": [
    {
      "name": "kebab-case-tag-name",
      "description": "Brief description of what this tag covers"
    }
  ],
  "chunk_assignments": [
    {
      "file_path": "exact/path/from/diff.ts",
      "chunk_index": 0,
      "tags": ["tag-name-1", "tag-name-2"],
      "priority": "high",
      "review_note": "Markdown note for the reviewer, or null if not high-priority"
    }
  ]
}

Rules:
- "tags" must define ALL tags before they are referenced in chunk_assignments.
- "chunk_assignments" must include EVERY chunk from the diff. Do not skip any.
- "file_path" and "chunk_index" must match the diff exactly.
- "priority" must be one of: "high", "medium", "low".
- "review_note" should be a markdown string for high-priority chunks, null otherwise.
- Each chunk must have at least one tag.

---

${userPrompt}`;
}

/**
 * Shared tool-disable map for all OpenCode prompts.
 * Disables all built-in tools so the LLM generates structured JSON only.
 */
const TOOLS_DISABLED = {
  bash: false,
  edit: false,
  write: false,
  read: false,
  grep: false,
  glob: false,
  list: false,
  webfetch: false,
  websearch: false,
  todowrite: false,
  task: false,
  skill: false,
  question: false,
  lsp: false,
  apply_patch: false,
} as const;

/**
 * Analyze PR chunks using OpenCode SDK with structured output.
 *
 * Two-phase pipeline:
 * 1. Tag Discovery: Single call with full diff → tags + chunk assignments (no summaries)
 * 2. Tag Summaries: Parallel calls per tag → one summary each
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
      const model = modelOverride ? `${modelOverride.provider}/${modelOverride.model}` : 'default';

      // ── Phase 1: Tag Discovery ──────────────────────────────
      console.log('[analyze] Phase 1: Tag discovery...');
      const taggingResult = await runTaggingPhase(
        client,
        prId,
        prTitle,
        prBody,
        prAuthor,
        baseBranch,
        headBranch,
        commitMessages,
        fileDiffs,
        model,
        modelOverride,
      );

      console.log(
        `[analyze] Phase 1 complete: ${taggingResult.chunkAssignments.length} chunks tagged, ${taggingResult.tags.length} tags defined`,
      );

      // Store chunk metadata and tags immediately (Phase 2 is additive)
      storeChunkMetadata(db, prId, run.id, taggingResult.chunkAssignments, taggingResult.tags);

      // ── Phase 2: Tag Summaries (parallel) ───────────────────
      console.log(
        `[analyze] Phase 2: Generating summaries for ${taggingResult.tags.length} tags (parallel)...`,
      );
      const tagSummaries = await runSummaryPhase(
        client,
        taggingResult.tags,
        taggingResult.chunkAssignments,
        fileDiffs,
        prTitle,
        prBody,
        modelOverride,
      );

      console.log(
        `[analyze] Phase 2 complete: ${tagSummaries.length}/${taggingResult.tags.length} summaries generated`,
      );

      // Build final result
      const result: LlmAnalysisResult = {
        tags: taggingResult.tags,
        chunkAssignments: taggingResult.chunkAssignments,
        tagSummaries,
      };

      // Update run status
      db.prepare(
        "UPDATE llm_runs SET status = 'completed', finished_at = datetime('now') WHERE id = ?",
      ).run(run.id);

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
      "UPDATE llm_runs SET status = 'failed', finished_at = datetime('now') WHERE id = ?",
    ).run(run.id);
    throw error;
  }
}

// ── Phase Runners ───────────────────────────────────────────

/** OpenCode client type — loosely typed to avoid importing internal SDK types. */
// biome-ignore lint/suspicious/noExplicitAny: SDK types are complex; we use minimal structural typing
type OpenCodeClient = any;

/**
 * Phase 1: Send the full diff and get tag assignments for every chunk.
 */
async function runTaggingPhase(
  client: OpenCodeClient,
  prId: number,
  prTitle: string,
  prBody: string,
  prAuthor: string,
  baseBranch: string,
  headBranch: string,
  commitMessages: string[],
  fileDiffs: ParsedFileDiff[],
  modelLabel: string,
  modelOverride?: LlmModelInfo,
): Promise<{ tags: LlmTagDefinition[]; chunkAssignments: LlmChunkAssignment[] }> {
  // Create a session
  const sessionResult = await client.session.create({
    title: `PR #${prId} Tagging`,
  });
  const session = sessionResult.data;
  if (!session) {
    throw new Error('Failed to create OpenCode session for tagging');
  }

  const systemPrompt = buildTaggingSystemPrompt();
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
  const systemKb = Math.round(Buffer.byteLength(systemPrompt, 'utf8') / 1024);
  console.log(
    `[analyze]   Tagging prompt (system: ${systemKb} KB, user: ${promptKb} KB) → ${modelLabel}`,
  );

  if (process.env.DEBUG_LLM_PROMPT) {
    console.log('[analyze] ─── TAGGING SYSTEM PROMPT START ───');
    console.log(systemPrompt);
    console.log('[analyze] ─── TAGGING SYSTEM PROMPT END ───');
    console.log('[analyze] ─── TAGGING USER PROMPT START ───');
    console.log(prompt);
    console.log('[analyze] ─── TAGGING USER PROMPT END ───');
  }

  // Subscribe to events for real-time logging
  const { eventLoop, stopEvents } = createEventLogger(client, session.id);

  const startTime = Date.now();
  const response = await client.session.prompt({
    sessionID: session.id,
    system: systemPrompt,
    parts: [{ type: 'text', text: prompt }],
    tools: TOOLS_DISABLED,
    ...(modelOverride && {
      model: { providerID: modelOverride.provider, modelID: modelOverride.model },
    }),
    format: {
      type: 'json_schema',
      schema: TAGGING_SCHEMA,
      retryCount: 2,
    },
  });

  await stopEvents();
  await eventLoop.catch(() => {});

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[analyze]   Tagging responded in ${elapsed}s`);

  // Parse response
  const data = response.data;
  if (!data) {
    if (response.error) {
      console.error('[analyze] SDK error:', JSON.stringify(response.error, null, 2));
    }
    console.error('[analyze] HTTP status:', response.response?.status);
    throw new Error(
      `No response data from tagging: ${response.error ? JSON.stringify(response.error) : 'unknown error'}`,
    );
  }

  if (data.info.error) {
    throw new Error(
      `Tagging error (${data.info.error.name}): ${JSON.stringify(data.info.error.data)}`,
    );
  }

  const structured = data.info.structured as RawTaggingResult | undefined;
  if (!structured) {
    throw new Error('No structured output returned from tagging');
  }

  return mapTaggingResult(structured);
}

/**
 * Phase 2: For each tag, send its chunks and get a summary. All calls run in parallel.
 * If a single summary fails, logs the error and continues with the rest.
 */
async function runSummaryPhase(
  client: OpenCodeClient,
  tags: LlmTagDefinition[],
  chunkAssignments: LlmChunkAssignment[],
  fileDiffs: ParsedFileDiff[],
  prTitle: string,
  prBody: string,
  modelOverride?: LlmModelInfo,
): Promise<LlmTagSummary[]> {
  // Build a lookup from filePath+chunkIndex to diff text
  const diffLookup = new Map<string, string>();
  for (const fd of fileDiffs) {
    for (const c of fd.chunks) {
      diffLookup.set(`${fd.filePath}:${c.chunkIndex}`, c.diffText);
    }
  }

  const summarySystemPrompt = buildSummarySystemPrompt();
  const startTime = Date.now();

  const results = await Promise.allSettled(
    tags.map(async (tag): Promise<LlmTagSummary> => {
      // Gather chunks for this tag
      const tagChunks = chunkAssignments
        .filter((a) => a.tags.includes(tag.name))
        .map((a) => ({
          filePath: a.filePath,
          chunkIndex: a.chunkIndex,
          diffText: diffLookup.get(`${a.filePath}:${a.chunkIndex}`) ?? '',
        }));

      if (tagChunks.length === 0) {
        return { tag: tag.name, summary: tag.description };
      }

      const summaryPrompt = buildSummaryPrompt(
        tag.name,
        tag.description,
        tagChunks,
        prTitle,
        prBody,
      );

      // Create a separate session for each summary
      const sessionResult = await client.session.create({
        title: `Summary: ${tag.name}`,
      });
      const session = sessionResult.data;
      if (!session) {
        throw new Error(`Failed to create session for tag "${tag.name}"`);
      }

      const response = await client.session.prompt({
        sessionID: session.id,
        system: summarySystemPrompt,
        parts: [{ type: 'text', text: summaryPrompt }],
        tools: TOOLS_DISABLED,
        ...(modelOverride && {
          model: { providerID: modelOverride.provider, modelID: modelOverride.model },
        }),
        format: {
          type: 'json_schema',
          schema: SUMMARY_SCHEMA,
          retryCount: 1,
        },
      });

      const data = response.data;
      if (!data || data.info.error) {
        throw new Error(`Summary failed for "${tag.name}": ${data?.info.error?.name ?? 'no data'}`);
      }

      const structured = data.info.structured as { summary: string } | undefined;
      if (!structured?.summary) {
        throw new Error(`No summary content for "${tag.name}"`);
      }

      return { tag: tag.name, summary: structured.summary };
    }),
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[analyze]   All summaries completed in ${elapsed}s`);

  // Collect results, log failures
  const summaries: LlmTagSummary[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      summaries.push(result.value);
    } else {
      console.error(`[analyze]   Summary failed for tag "${tags[i].name}": ${result.reason}`);
    }
  }

  return summaries;
}

// ── Event Logger ────────────────────────────────────────────

function createEventLogger(
  client: OpenCodeClient,
  sessionId: string,
): { eventLoop: Promise<void>; stopEvents: () => Promise<void> } {
  let stopEventStream = false;
  // biome-ignore lint/suspicious/noExplicitAny: SDK stream type is complex
  let eventStream: any = null;

  const eventLoop = (async () => {
    try {
      const eventResult = await client.event.subscribe();
      eventStream = eventResult.stream;

      for await (const event of eventStream) {
        if (stopEventStream) break;
        const evt = event as { type: string; properties?: Record<string, unknown> };
        if (!evt.properties) continue;

        const evtSessionId = evt.properties.sessionID as string | undefined;
        if (evtSessionId && evtSessionId !== sessionId) continue;

        switch (evt.type) {
          case 'session.status': {
            const status = evt.properties.status as { type: string; message?: string };
            if (status.type === 'retry') {
              console.log(`[analyze] LLM retrying: ${status.message ?? 'unknown reason'}`);
            } else if (status.type === 'busy') {
              console.log('[analyze] LLM processing...');
            }
            break;
          }
          case 'session.error': {
            const error = evt.properties.error as { name?: string; data?: unknown } | undefined;
            console.error(
              `[analyze] LLM error event: ${error?.name ?? 'unknown'}`,
              error?.data ? JSON.stringify(error.data) : '',
            );
            break;
          }
          case 'message.part.updated': {
            const part = evt.properties.part as { type: string; [key: string]: unknown };
            if (part.type === 'tool') {
              const tool = part.tool as string;
              const state = part.state as { status?: string } | string;
              const stateStr = typeof state === 'string' ? state : JSON.stringify(state);
              console.log(`[analyze]   tool: ${tool} [${stateStr}]`);
            } else if (part.type === 'step-start') {
              console.log('[analyze]   step started');
            } else if (part.type === 'step-finish') {
              const tokens = part.tokens as { input: number; output: number };
              const cost = part.cost as number;
              console.log(
                `[analyze]   step finished (${tokens.input} in / ${tokens.output} out, $${cost.toFixed(4)})`,
              );
            } else if (part.type === 'retry') {
              const attempt = part.attempt as number;
              const error = part.error as { name?: string } | undefined;
              console.log(
                `[analyze]   retry attempt ${attempt}: ${error?.name ?? 'unknown error'}`,
              );
            } else if (part.type === 'text') {
              const text = (part.text as string) ?? '';
              const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;
              if (preview.trim()) {
                console.log(`[analyze]   text: ${preview}`);
              }
            }
            break;
          }
          default:
            break;
        }
      }
    } catch {
      // Stream closed — expected when we stop it
    }
  })();

  const stopEvents = async (): Promise<void> => {
    stopEventStream = true;
    eventStream?.return(undefined);
  };

  return { eventLoop, stopEvents };
}

// ── Internal Types ──────────────────────────────────────────

export interface RawTaggingResult {
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
}

// ── Helpers ─────────────────────────────────────────────────

export function mapTaggingResult(raw: RawTaggingResult): {
  tags: LlmTagDefinition[];
  chunkAssignments: LlmChunkAssignment[];
} {
  return {
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
  };
}

export function validatePriority(p: string): Priority {
  if (p === 'high' || p === 'medium' || p === 'low') return p;
  return 'medium';
}

export function storeChunkMetadata(
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
