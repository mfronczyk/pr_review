/**
 * InlineComment – shows existing comments and a form to add/edit comments on a chunk.
 */

import { useState } from 'react';

import type { Comment } from '@pr-review/shared';

interface InlineCommentProps {
  comments: Comment[];
  onAdd: (body: string) => Promise<void>;
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
      <div className="flex flex-col gap-1.5 rounded bg-gray-800 p-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[60px] w-full resize-y rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100 focus:border-blue-500 focus:outline-none"
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
            className="rounded px-2 py-0.5 text-xs text-gray-400 hover:text-white"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2 rounded bg-gray-800/50 p-2">
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap text-xs text-gray-200">{comment.body}</p>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-500">
          <span>{new Date(comment.createdAt).toLocaleString()}</span>
          {comment.publishedAt && <span className="text-green-600">Published</span>}
        </div>
      </div>
      {!comment.publishedAt && (
        <div className="hidden flex-shrink-0 gap-1 group-hover:flex">
          <button
            type="button"
            onClick={handlePublish}
            disabled={saving}
            className="rounded px-1.5 py-0.5 text-[10px] text-green-400 hover:bg-green-900/50 hover:text-green-300"
          >
            Publish
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded px-1.5 py-0.5 text-[10px] text-gray-400 hover:bg-gray-700 hover:text-white"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={saving}
            className="rounded px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-900/50 hover:text-red-300"
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
}: {
  onAdd: (body: string) => Promise<void>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(): Promise<void> {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await onAdd(body.trim());
      setBody('');
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-gray-500 hover:text-blue-400"
      >
        + Add comment
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a review comment..."
        className="min-h-[60px] w-full resize-y rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
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
            setOpen(false);
          }}
          className="rounded px-2 py-0.5 text-xs text-gray-400 hover:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function InlineComment({
  comments,
  onAdd,
  onUpdate,
  onDelete,
  onPublish,
}: InlineCommentProps): React.ReactElement {
  return (
    <div className="space-y-1.5 border-b border-gray-800 bg-gray-900/50 px-3 py-2">
      {comments.map((c) => (
        <CommentItem
          key={c.id}
          comment={c}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onPublish={onPublish}
        />
      ))}
      <AddCommentForm onAdd={onAdd} />
    </div>
  );
}
