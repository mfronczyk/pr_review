/**
 * API client for communicating with the PR Review backend.
 * All requests go to /api/* which Vite proxies to the Express server.
 */

import type {
  AddPrRequest,
  ChunkWithDetails,
  Comment,
  LlmAnalysisResult,
  LlmModelInfo,
  PrWithProgress,
  PullRequest,
  ReviewEvent,
  ServerConfig,
  SubmitReviewResponse,
  SyncResult,
  Tag,
  TagSummary,
} from '@pr-review/shared';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Server Config ───────────────────────────────────────────

export function getConfig(): Promise<ServerConfig> {
  return request('/api/config');
}

// ── PRs ─────────────────────────────────────────────────────

export function listPrs(): Promise<PrWithProgress[]> {
  return request('/api/prs');
}

export function getPr(id: number): Promise<PrWithProgress> {
  return request(`/api/prs/${id}`);
}

export function addPr(data: AddPrRequest): Promise<PullRequest> {
  return request('/api/prs', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deletePr(id: number): Promise<void> {
  return request(`/api/prs/${id}`, { method: 'DELETE' });
}

export function syncPr(id: number): Promise<SyncResult> {
  return request(`/api/prs/${id}/sync`, { method: 'POST' });
}

export function analyzePr(id: number): Promise<LlmAnalysisResult> {
  return request(`/api/prs/${id}/analyze`, { method: 'POST' });
}

export function getTagSummaries(prId: number): Promise<TagSummary[]> {
  return request(`/api/prs/${prId}/tag-summaries`);
}

export function submitReview(
  id: number,
  event: ReviewEvent,
  body?: string,
): Promise<SubmitReviewResponse> {
  return request(`/api/prs/${id}/submit-review`, {
    method: 'POST',
    body: JSON.stringify({ event, body: body || undefined }),
  });
}

// ── LLM ─────────────────────────────────────────────────────

export function getModelInfo(): Promise<LlmModelInfo> {
  return request('/api/llm/model');
}

// ── Chunks ──────────────────────────────────────────────────

export function getChunks(prId: number): Promise<ChunkWithDetails[]> {
  return request(`/api/prs/${prId}/chunks`);
}

export function getChunk(id: number): Promise<ChunkWithDetails> {
  return request(`/api/chunks/${id}`);
}

export function toggleApproved(id: number): Promise<ChunkWithDetails> {
  return request(`/api/chunks/${id}/approved`, { method: 'PATCH' });
}

export function updateMetadata(
  id: number,
  data: { priority?: string; reviewNote?: string | null },
): Promise<ChunkWithDetails> {
  return request(`/api/chunks/${id}/metadata`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function setChunkTags(id: number, tagIds: number[]): Promise<ChunkWithDetails> {
  return request(`/api/chunks/${id}/tags`, {
    method: 'PUT',
    body: JSON.stringify({ tagIds }),
  });
}

export function bulkApprove(prId: number, tagId: number): Promise<{ approved: number }> {
  return request(`/api/prs/${prId}/bulk-approve`, {
    method: 'POST',
    body: JSON.stringify({ tagId }),
  });
}

export function getTags(prId: number): Promise<Tag[]> {
  return request(`/api/prs/${prId}/tags`);
}

// ── Context Lines ───────────────────────────────────────────

export interface ContextLine {
  lineNumber: number;
  content: string;
}

export function getContextLines(
  prId: number,
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<{ lines: ContextLine[] }> {
  const params = new URLSearchParams({
    filePath,
    startLine: String(startLine),
    endLine: String(endLine),
  });
  return request(`/api/prs/${prId}/context?${params}`);
}

// ── Comments ────────────────────────────────────────────────

export function getComments(prId: number): Promise<Comment[]> {
  return request(`/api/prs/${prId}/comments`);
}

export function createComment(data: {
  chunkId: number;
  prId: number;
  body: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  parentId?: number;
}): Promise<Comment> {
  return request('/api/comments', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateComment(id: number, body: string): Promise<Comment> {
  return request(`/api/comments/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

export function deleteComment(id: number): Promise<void> {
  return request(`/api/comments/${id}`, { method: 'DELETE' });
}

export function publishComment(
  id: number,
  data: { owner: string; repo: string; prNumber: number; ghHost?: string; commitSha: string },
): Promise<Comment> {
  return request(`/api/comments/${id}/publish`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function publishAllComments(
  prId: number,
  data: { owner: string; repo: string; prNumber: number; ghHost?: string; commitSha: string },
): Promise<{ published: number }> {
  return request(`/api/prs/${prId}/publish-comments`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function resolveThread(id: number): Promise<Comment> {
  return request(`/api/comments/${id}/resolve`, { method: 'POST' });
}

export function unresolveThread(id: number): Promise<Comment> {
  return request(`/api/comments/${id}/unresolve`, { method: 'POST' });
}
