/**
 * Shared type definitions for the PR Review application.
 *
 * These types represent the core domain model shared between
 * the server and client packages.
 */

// ── PR ──────────────────────────────────────────────────────

export interface PullRequest {
  id: number;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: PrState;
  baseRef: string;
  headRef: string;
  headSha: string;
  body: string;
  ghHost: string;
  createdAt: string;
  updatedAt: string;
}

export type PrState = 'open' | 'closed' | 'merged' | 'draft';

// ── Chunk ───────────────────────────────────────────────────

export interface Chunk {
  id: number;
  prId: number;
  filePath: string;
  chunkIndex: number;
  contentHash: string;
  diffText: string;
  startLine: number;
  endLine: number;
  approved: boolean;
  approvedAt: string | null;
}

export type ReviewState = 'unapproved' | 'approved' | 'outdated';

// ── Tag ─────────────────────────────────────────────────────

export interface Tag {
  id: number;
  prId: number;
  name: string;
  description: string;
}

export interface ChunkTag {
  chunkId: number;
  tagId: number;
}

// ── Chunk Metadata (LLM-assigned) ──────────────────────────

export type Priority = 'high' | 'medium' | 'low';

export interface ChunkMetadata {
  chunkId: number;
  priority: Priority;
  reviewNote: string | null;
  llmRunId: number | null;
}

// ── Comment ─────────────────────────────────────────────────

/** Which side of the diff the comment is anchored to. */
export type DiffSide = 'LEFT' | 'RIGHT';

export interface Comment {
  id: number;
  chunkId: number;
  prId: number;
  body: string;
  line: number;
  side: DiffSide;
  parentId: number | null;
  author: string | null;
  ghCommentId: number | null;
  ghNodeId: string | null;
  resolved: boolean;
  createdAt: string;
  publishedAt: string | null;
}

/**
 * A thread is a root comment plus its flat list of replies.
 * Grouped on the client from the flat Comment[] array.
 */
export interface CommentThread {
  root: Comment;
  replies: Comment[];
}

// ── LLM Model Info ──────────────────────────────────────────

export interface LlmModelInfo {
  provider: string;
  model: string;
}

// ── LLM Run ─────────────────────────────────────────────────

export type LlmRunStatus = 'running' | 'completed' | 'failed';

export interface LlmRun {
  id: number;
  prId: number;
  startedAt: string;
  finishedAt: string | null;
  status: LlmRunStatus;
}

// ── LLM Analysis Output ────────────────────────────────────

export interface LlmTagDefinition {
  name: string;
  description: string;
}

export interface LlmChunkAssignment {
  filePath: string;
  chunkIndex: number;
  tags: string[];
  priority: Priority;
  reviewNote: string | null;
}

export interface LlmAnalysisResult {
  tags: LlmTagDefinition[];
  chunkAssignments: LlmChunkAssignment[];
  tagSummaries: LlmTagSummary[];
}

export interface LlmTagSummary {
  tag: string;
  summary: string;
}

// ── API Request/Response Types ──────────────────────────────

export interface AddPrRequest {
  owner: string;
  repo: string;
  number: number;
  ghHost?: string;
}

export interface PrWithProgress extends PullRequest {
  totalChunks: number;
  approvedChunks: number;
  additions: number;
  deletions: number;
}

export interface ChunkWithDetails extends Chunk {
  tags: Tag[];
  metadata: ChunkMetadata | null;
  comments: Comment[];
}

export interface SyncResult {
  added: number;
  removed: number;
  updated: number;
  outdated: number;
}

// ── Review Submission ──────────────────────────────────────

export type ReviewEvent = 'APPROVE' | 'COMMENT';

export interface SubmitReviewRequest {
  event: ReviewEvent;
  body?: string;
}

export interface SubmitReviewResponse {
  id: number;
  state: string;
  submittedAt: string;
}

// ── Server Config ──────────────────────────────────────────

export interface ServerConfig {
  repoPath: string;
}

// ── Manual Analysis (Prompt Download / Import) ─────────────

/**
 * Request body for importing manually-generated LLM analysis results.
 * Uses snake_case keys to match the raw LLM JSON output format,
 * so users can paste the LLM response directly without transformation.
 */
export interface ImportAnalysisRequest {
  tags: Array<{ name: string; description: string }>;
  chunk_assignments: Array<{
    file_path: string;
    chunk_index: number;
    tags: string[];
    priority: string;
    review_note: string | null;
  }>;
}

/**
 * Response from the prompt download endpoint.
 * Contains the full prompt text and a suggested filename.
 */
export interface PromptDownloadResponse {
  prompt: string;
  filename: string;
}

// ── Tag Summary ────────────────────────────────────────────

export interface TagSummary {
  tagId: number;
  tagName: string;
  summary: string;
}
