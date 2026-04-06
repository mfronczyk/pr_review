/**
 * InlineComment – renders a single comment thread (root + replies) inline in the diff.
 * Supports resolve/unresolve, reply, edit, delete, and publish actions.
 */

import { useState } from 'react';

import { Markdown } from '@/components/Markdown';
import type { Comment, CommentThread } from '@pr-review/shared';

interface InlineThreadProps {
  thread: CommentThread;
  onReply: (parentId: number, body: string) => Promise<void>;
  onUpdate: (id: number, body: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onPublish: (id: number) => Promise<void>;
  onResolve: (id: number) => Promise<void>;
  onUnresolve: (id: number) => Promise<void>;
}

interface AddCommentFormProps {
  onAdd: (body: string) => Promise<void>;
  onCancel: () => void;
  placeholder?: string;
  submitLabel?: string;
}

// ── Single Comment Item ─────────────────────────────────────

function CommentItem({
  comment,
  onUpdate,
  onDelete,
  onPublish,
}: {
  comment: Comment;
  onUpdate: (id: number, body: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onPublish: (id: number) => Promise<void>;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [saving, setSaving] = useState(false);

  const authorLabel = comment.author ? `@${comment.author}` : 'You';
  const isLocal = !comment.author;

  async function handleSave(): Promise<void> {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await onUpdate(comment.id, body.trim());
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setSaving(true);
    try {
      await onDelete(comment.id);
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish(): Promise<void> {
    setSaving(true);
    try {
      await onPublish(comment.id);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5 rounded bg-surface-secondary p-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[60px] w-full resize-y rounded border border-border-primary bg-surface-input px-2 py-1 text-xs text-fg-primary focus:border-blue-500 focus:outline-none"
          disabled={saving}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !body.trim()}
            className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setBody(comment.body);
              setEditing(false);
            }}
            className="rounded px-2 py-0.5 text-xs text-fg-tertiary hover:text-fg-primary"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex max-w-3xl items-start gap-2 rounded bg-surface-secondary/50 p-2">
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-1.5">
          <span
            className={`text-[10px] font-medium ${isLocal ? 'text-blue-500' : 'text-fg-tertiary'}`}
          >
            {authorLabel}
          </span>
          <span className="text-[10px] text-fg-muted">
            {new Date(comment.createdAt).toLocaleString()}
          </span>
          {comment.publishedAt && <span className="text-[10px] text-success-fg">Published</span>}
        </div>
        <Markdown variant="comment" text={comment.body} />
      </div>
      {isLocal && !comment.publishedAt && (
        <div className="hidden flex-shrink-0 gap-1 group-hover:flex">
          <button
            type="button"
            onClick={handlePublish}
            disabled={saving}
            className="rounded px-1.5 py-0.5 text-[10px] text-green-600 hover:bg-green-100 hover:text-green-700 dark:text-green-400 dark:hover:bg-green-900/50 dark:hover:text-green-300"
          >
            Publish
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded px-1.5 py-0.5 text-[10px] text-fg-tertiary hover:bg-surface-tertiary hover:text-fg-primary"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={saving}
            className="rounded px-1.5 py-0.5 text-[10px] text-red-500 hover:bg-red-100 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-900/50 dark:hover:text-red-300"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ── Add Comment Form ────────────────────────────────────────

function AddCommentForm({
  onAdd,
  onCancel,
  placeholder = 'Write a review comment...',
  submitLabel = 'Add Comment',
}: AddCommentFormProps): React.ReactElement {
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(): Promise<void> {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await onAdd(body.trim());
      setBody('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        className="min-h-[60px] w-full resize-y rounded border border-border-primary bg-surface-input px-2 py-1 text-xs text-fg-primary placeholder-fg-muted focus:border-blue-500 focus:outline-none"
        disabled={saving}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={saving || !body.trim()}
          className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? 'Saving...' : submitLabel}
        </button>
        <button
          type="button"
          onClick={() => {
            setBody('');
            onCancel();
          }}
          className="rounded px-2 py-0.5 text-xs text-fg-tertiary hover:text-fg-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── New Comment Form (for starting a new thread) ────────────

export function NewCommentForm({
  onAdd,
  onCancel,
}: {
  onAdd: (body: string) => Promise<void>;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div className="border-t border-border-secondary bg-surface-primary/50 px-3 py-2">
      <div className="max-w-3xl">
        <AddCommentForm onAdd={onAdd} onCancel={onCancel} />
      </div>
    </div>
  );
}

// ── Thread Component ────────────────────────────────────────

export function InlineThread({
  thread,
  onReply,
  onUpdate,
  onDelete,
  onPublish,
  onResolve,
  onUnresolve,
}: InlineThreadProps): React.ReactElement {
  const [replying, setReplying] = useState(false);
  const { root, replies } = thread;

  if (root.resolved) {
    // Collapsed resolved thread — single line
    return (
      <div className="border-t border-border-secondary bg-surface-primary/50 px-3 py-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span className="text-[10px] font-medium text-fg-tertiary">
              {root.author ? `@${root.author}` : 'You'}
            </span>
            <span className="truncate italic opacity-60">{root.body}</span>
            <span className="rounded bg-green-100 px-1 py-0.5 text-[10px] text-green-700 dark:bg-green-900/50 dark:text-green-300">
              Resolved
            </span>
          </div>
          <button
            type="button"
            onClick={() => onUnresolve(root.id)}
            className="rounded px-1.5 py-0.5 text-[10px] text-fg-tertiary hover:bg-surface-tertiary hover:text-fg-primary"
          >
            Unresolve
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-border-secondary bg-surface-primary/50 px-3 py-2">
      <div className="max-w-3xl space-y-1.5">
        {/* Root comment */}
        <CommentItem comment={root} onUpdate={onUpdate} onDelete={onDelete} onPublish={onPublish} />

        {/* Replies */}
        {replies.length > 0 && (
          <div className="ml-4 space-y-1.5 border-l-2 border-border-secondary pl-2">
            {replies.map((reply) => (
              <CommentItem
                key={reply.id}
                comment={reply}
                onUpdate={onUpdate}
                onDelete={onDelete}
                onPublish={onPublish}
              />
            ))}
          </div>
        )}

        {/* Actions bar */}
        <div className="flex items-center gap-2">
          {!replying && (
            <button
              type="button"
              onClick={() => setReplying(true)}
              className="rounded px-1.5 py-0.5 text-[10px] text-blue-500 hover:bg-blue-100 hover:text-blue-700 dark:hover:bg-blue-900/50 dark:hover:text-blue-300"
            >
              Reply
            </button>
          )}
          <button
            type="button"
            onClick={() => onResolve(root.id)}
            className="rounded px-1.5 py-0.5 text-[10px] text-green-600 hover:bg-green-100 hover:text-green-700 dark:text-green-400 dark:hover:bg-green-900/50 dark:hover:text-green-300"
          >
            Resolve
          </button>
        </div>

        {/* Reply form */}
        {replying && (
          <div className="ml-4 border-l-2 border-border-secondary pl-2">
            <AddCommentForm
              onAdd={async (body) => {
                await onReply(root.id, body);
                setReplying(false);
              }}
              onCancel={() => setReplying(false)}
              placeholder="Write a reply..."
              submitLabel="Reply"
            />
          </div>
        )}
      </div>
    </div>
  );
}
