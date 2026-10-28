import type { ReactNode } from 'react';

/** Shared selected words and their paired comment; permission and source navigation stay with the host. */
export function QuoteExcerpt({
  text,
  comment,
  commentLabel,
  compact = false,
}: {
  readonly text: string;
  readonly comment?: string;
  readonly commentLabel?: ReactNode;
  readonly compact?: boolean;
}) {
  return (
    <span className="cafe-quote-excerpt" data-compact={compact || undefined}>
      <span className="cafe-quote-text">{text}</span>
      {comment && (
        <span className="cafe-quote-comment">
          {commentLabel && <strong>{commentLabel} </strong>}
          {comment}
        </span>
      )}
    </span>
  );
}
