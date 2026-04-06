/**
 * Renders markdown content with styled typography.
 * Used for PR summaries, tag group summaries, review notes, and comments.
 */

import ReactMarkdown from 'react-markdown';

type MarkdownVariant = 'prose' | 'compact' | 'comment';

interface MarkdownProps {
  text: string;
  className?: string;
  /** Use compact styling (smaller text, tighter spacing) for inline contexts like review notes. */
  compact?: boolean;
  /** Explicit variant selection. Overrides `compact` if provided. */
  variant?: MarkdownVariant;
}

const VARIANT_CLASS: Record<MarkdownVariant, string> = {
  prose: 'markdown-prose',
  compact: 'markdown-compact',
  comment: 'markdown-comment',
};

export function Markdown({
  text,
  className = '',
  compact = false,
  variant,
}: MarkdownProps): React.ReactElement {
  const resolved = variant ?? (compact ? 'compact' : 'prose');
  return (
    <div className={`${VARIANT_CLASS[resolved]} ${className}`}>
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
}
