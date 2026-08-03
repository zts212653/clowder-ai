'use client';

import { type CSSProperties, useId, useState } from 'react';
import { useMeasuredOverflow } from './useMeasuredOverflow';

interface ExpandableProseProps {
  text: string;
  lines?: 2 | 3 | 4;
  className?: string;
  contentClassName?: string;
}

export function ExpandableProse({
  text,
  lines = 3,
  className = '',
  contentClassName = 'text-sm leading-6 text-cafe-secondary',
}: ExpandableProseProps) {
  const contentId = useId();
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const expanded = expandedText === text;
  const { ref, overflowing } = useMeasuredOverflow<HTMLDivElement>({
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

  return (
    <div className={className}>
      <div
        id={contentId}
        ref={ref}
        data-overflow-measure="block"
        className={`whitespace-pre-wrap break-words ${contentClassName}`}
        style={collapsedStyle}
      >
        {text}
      </div>
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
