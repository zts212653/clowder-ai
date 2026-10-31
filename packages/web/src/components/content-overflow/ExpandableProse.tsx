'use client';

import { type CSSProperties, createElement, useId, useState } from 'react';
import { useMeasuredOverflow } from './useMeasuredOverflow';

interface ExpandableProseProps {
  text: string;
  lines?: 2 | 3 | 4;
  as?: 'div' | 'h3' | 'p';
  className?: string;
  contentClassName?: string;
}

export function ExpandableProse({
  text,
  lines = 3,
  as: Content = 'div',
  className = '',
  contentClassName = 'text-sm leading-6 text-cafe-secondary',
}: ExpandableProseProps) {
  const contentId = useId();
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const expanded = expandedText === text;
  const { ref, overflowing } = useMeasuredOverflow<HTMLElement>({
    axis: 'block',
    active: !expanded,
  });

  const collapsedStyle: CSSProperties | undefined = expanded
    ? undefined
    : {
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: lines,
        overflow: 'hidden',
      };

  const content = createElement(
    Content,
    {
      id: contentId,
      ref,
      'data-overflow-measure': 'block',
      className: `whitespace-pre-wrap break-words ${contentClassName}`,
      style: collapsedStyle,
    },
    text,
  );

  return (
    <div className={className}>
      {content}
      {overflowing && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setExpandedText(expanded ? null : text);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mt-2 rounded-md px-2 py-1 text-xs font-semibold text-cafe-accent transition-colors hover:bg-cafe-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
        >
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
    </div>
  );
}
