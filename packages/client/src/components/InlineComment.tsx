/**
 * InlineComment – shows existing comments and a form to add/edit comments on a chunk.
 */

import { useState } from 'react';

import type { Comment } from '@pr-review/shared';

interface InlineCommentProps {
  comments: Comment[];
  showForm: boolean;
  onAdd: (body: string) => Promise<void>;
  onCancelForm: () => void;
  onUpdate: (id: number, body: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onPublish: (id: number) => Promise<void>;
}

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
    <div className="group flex items-start gap-2 rounded bg-surface-secondary/50 p-2">
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap text-xs text-fg-secondary">{comment.body}</p>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-fg-muted">
          <span>{new Date(comment.createdAt).toLocaleString()}</span>
          {comment.publishedAt && <span className="text-success-fg">Published</span>}
        </div>
      </div>
      {!comment.publishedAt && (
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

function AddCommentForm({
  onAdd,
  onCancel,
}: {
  onAdd: (body: string) => Promise<void>;
  onCancel: () => void;
}): React.ReactElement {
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
        placeholder="Write a review comment..."
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
          {saving ? 'Adding...' : 'Add Comment'}
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

export function InlineComment({
  comments,
  showForm,
  onAdd,
  onCancelForm,
  onUpdate,
  onDelete,
  onPublish,
}: InlineCommentProps): React.ReactElement {
  return (
    <div className="space-y-1.5 border-t border-border-secondary bg-surface-primary/50 px-3 py-2">
      {comments.map((c) => (
        <CommentItem
          key={c.id}
          comment={c}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onPublish={onPublish}
        />
      ))}
      {showForm && <AddCommentForm onAdd={onAdd} onCancel={onCancelForm} />}
    </div>
  );
}
