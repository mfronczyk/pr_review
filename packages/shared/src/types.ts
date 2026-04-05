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
  reviewed: boolean;
  reviewedAt: string | null;
}

export type ReviewState = 'unreviewed' | 'reviewed' | 'outdated';

// ── Tag ─────────────────────────────────────────────────────

export interface Tag {
  id: number;
  name: string;
  description: string;
  color: string;
  isDefault: boolean;
}

export interface ChunkTag {
  chunkId: number;
  tagId: number;
}

export const DEFAULT_TAG_NAMES = [
  'bug-fix',
  'refactor',
  'new-feature',
  'style/formatting',
  'tests',
  'docs',
  'config',
  'security',
  'performance',
  'needs-discussion',
] as const;

export type DefaultTagName = (typeof DEFAULT_TAG_NAMES)[number];

// ── Chunk Metadata (LLM-assigned) ──────────────────────────

export type Priority = 'high' | 'medium' | 'low';

export interface ChunkMetadata {
  chunkId: number;
  priority: Priority;
  reviewNote: string | null;
  llmRunId: number | null;
}

// ── Comment ─────────────────────────────────────────────────

export interface Comment {
  id: number;
  chunkId: number;
  prId: number;
  body: string;
  line: number;
  parentId: number | null;
  author: string | null;
  ghCommentId: number | null;
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

// ── LLM Run ─────────────────────────────────────────────────

export type LlmRunStatus = 'running' | 'completed' | 'failed';

export interface LlmRun {
  id: number;
  prId: number;
  startedAt: string;
  finishedAt: string | null;
  status: LlmRunStatus;
  summary: string | null;
}

// ── LLM Analysis Output ────────────────────────────────────

export interface LlmSuggestedTag {
  name: string;
  description: string;
  color: string;
}

export interface LlmChunkAssignment {
  filePath: string;
  chunkIndex: number;
  tags: string[];
  priority: Priority;
  reviewNote: string | null;
}

export interface LlmAnalysisResult {
  prSummary: string;
  suggestedTags: LlmSuggestedTag[];
  chunkAssignments: LlmChunkAssignment[];
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
  reviewedChunks: number;
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
