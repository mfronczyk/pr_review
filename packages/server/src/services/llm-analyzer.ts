import type { DatabaseSync } from 'node:sqlite';
import type { LlmChunkAssignment, LlmTagDefinition, Priority } from '@pr-review/shared';
import type { ParsedFileDiff } from './diff-parser.js';

export interface LlmAnalyzerOptions {
  db: DatabaseSync;
  repoPath: string;
}

/**
 * Build the system prompt for tag discovery and chunk assignment.
 */
export function buildTaggingSystemPrompt(): string {
  return `You are a senior code reviewer helping a human reviewer understand a pull request.

Your purpose is to split this change into different aspects — like a prism splitting light —
so the reviewer can examine each dimension of the change independently. Good tagging helps
the reviewer focus on one concern at a time (e.g., all the database changes, then all the
validation logic, then the tests) rather than reviewing files linearly.

Use the diff chunks, commit messages, branch name, and PR description to understand the intent
and context behind the changes. If the diff references functions, classes, or patterns that suggest a
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
Examples: tests, unit-tests, integration-tests, docs, config, security, authentication,
performance, observability, model, error-handling, parsing, validation,
ci-cd, kubernetes, agent-files, dependencies, packaging

Not every dimension applies to every chunk. Assign tags from multiple dimensions when applicable.

## Instructions

1. **Define Tags**: Define ALL tags you will use. Each tag needs a short name (kebab-case) and
   a brief description. Make functionality tags very specific to this PR — name them after the
   domain concepts, features, or behaviors you see in the code.

2. **Assign Chunks**: For EVERY chunk in the diff, assign:
   - One or more tags (from the tags you defined in step 1)
   - A priority (high/medium/low) based on review importance
   - A review_note ONLY for high-priority chunks or chunks needing special attention (null otherwise).
     The review note should tell the reviewer what to focus on — e.g., a subtle edge case,
     a potential race condition, a security concern, or a behavioral change that may not be obvious
     from the diff alone.
    Every chunk MUST receive at least one tag. Do not skip any chunks.

## Formatting

The review_note field is rendered as **markdown**. Use markdown formatting for readability:
- **Bold** for emphasis on key terms, file names, or concepts
- \`inline code\` for function names, variable names, file paths, and code references

Be precise with file_path and chunk_index — they must match the diff exactly.`;
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
 * Build a self-contained prompt for manual LLM analysis via any LLM chat UI.
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
  db: DatabaseSync,
  prId: number,
  llmRunId: number,
  assignments: LlmChunkAssignment[],
  tagDefinitions: LlmTagDefinition[],
): void {
  const getChunk = db.prepare(
    'SELECT id, content_hash FROM chunks WHERE pr_id = ? AND file_path = ? AND chunk_index = ?',
  );

  const upsertMetadata = db.prepare(`
    INSERT INTO chunk_metadata (pr_id, content_hash, priority, review_note, llm_run_id)
    VALUES (@prId, @contentHash, @priority, @reviewNote, @llmRunId)
    ON CONFLICT (pr_id, content_hash) DO UPDATE SET
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
    INSERT OR IGNORE INTO chunk_tags (pr_id, content_hash, tag_id) VALUES (?, ?, ?)
  `);

  const clearChunkTags = db.prepare('DELETE FROM chunk_tags WHERE pr_id = ? AND content_hash = ?');

  // Build a lookup from tag name to description from LLM definitions
  const tagDescriptions = new Map<string, string>();
  for (const td of tagDefinitions) {
    tagDescriptions.set(td.name, td.description);
  }

  const store = (): void => {
    db.exec('BEGIN');
    try {
      for (const assignment of assignments) {
        const chunk = getChunk.get(prId, assignment.filePath, assignment.chunkIndex) as
          | { id: number; content_hash: string }
          | undefined;

        if (!chunk) continue;

        // Upsert metadata keyed by (pr_id, content_hash)
        upsertMetadata.run({
          prId,
          contentHash: chunk.content_hash,
          priority: assignment.priority,
          reviewNote: assignment.reviewNote,
          llmRunId,
        });

        // Clear existing tags and re-assign (keyed by pr_id, content_hash)
        clearChunkTags.run(prId, chunk.content_hash);

        for (const tagName of assignment.tags) {
          const tag = getOrCreateTag.get({
            name: tagName,
            description: tagDescriptions.get(tagName) ?? '',
            prId,
          }) as { id: number };

          insertChunkTag.run(prId, chunk.content_hash, tag.id);
        }
      }

      // Assign 'unassigned' tag to any chunks that have no tags
      const untaggedChunks = db
        .prepare(
          `SELECT c.id, c.content_hash FROM chunks c
           WHERE c.pr_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM chunk_tags ct
               WHERE ct.pr_id = c.pr_id AND ct.content_hash = c.content_hash
             )`,
        )
        .all(prId) as Array<{ id: number; content_hash: string }>;

      if (untaggedChunks.length > 0) {
        const unassignedTag = getOrCreateTag.get({
          name: 'unassigned',
          description: 'Chunks not categorized by LLM analysis',
          prId,
        }) as { id: number };

        for (const chunk of untaggedChunks) {
          insertChunkTag.run(prId, chunk.content_hash, unassignedTag.id);
        }

        console.log(
          `[analyze] Assigned 'unassigned' tag to ${untaggedChunks.length} chunks without tags`,
        );
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  store();
}
