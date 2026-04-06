/**
 * Dialog for submitting a PR review with APPROVE or COMMENT status.
 * Includes an optional summary textarea.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReviewEvent } from '@pr-review/shared';

interface SubmitReviewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (event: ReviewEvent, body?: string) => Promise<void>;
  isSubmitting: boolean;
}

export function SubmitReviewDialog({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting,
}: SubmitReviewDialogProps): React.ReactElement | null {
  const [body, setBody] = useState('');
  const overlayRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when dialog opens
  useEffect(() => {
    if (isOpen) {
      // Small delay to let the DOM render
      const timer = setTimeout(() => textareaRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Close on Escape key (document-level so it works regardless of focus)
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !isSubmitting) {
        onClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  // Reset body when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setBody('');
    }
  }, [isOpen]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === overlayRef.current && !isSubmitting) {
        onClose();
      }
    },
    [isSubmitting, onClose],
  );

  const handleSubmit = useCallback(
    async (event: ReviewEvent) => {
      await onSubmit(event, body.trim() || undefined);
    },
    [body, onSubmit],
  );

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !isSubmitting) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="w-full max-w-md rounded-lg border border-border-primary bg-surface-primary shadow-xl">
        {/* Header */}
        <div className="border-b border-border-secondary px-4 py-3">
          <h2 className="text-sm font-semibold text-fg-primary">Submit Review</h2>
        </div>

        {/* Body */}
        <div className="px-4 py-3">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Leave a summary (optional)"
            disabled={isSubmitting}
            rows={4}
            className="w-full resize-y rounded-md border border-border-primary bg-surface-input px-3 py-2 text-xs text-fg-primary placeholder:text-fg-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border-secondary px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-md border border-border-primary bg-surface-secondary px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-tertiary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => handleSubmit('COMMENT')}
            disabled={isSubmitting}
            className="rounded-md border border-border-primary bg-surface-secondary px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-tertiary disabled:opacity-50"
          >
            {isSubmitting ? 'Submitting...' : 'Comment'}
          </button>
          <button
            type="button"
            onClick={() => handleSubmit('APPROVE')}
            disabled={isSubmitting}
            className="rounded-md bg-green-700 px-3 py-1.5 text-xs text-white hover:bg-green-600 disabled:opacity-50"
          >
            {isSubmitting ? 'Submitting...' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}
