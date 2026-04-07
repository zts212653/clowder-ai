'use client';

import React, { useState } from 'react';

/**
 * Text that is clamped/truncated by default, click to expand full content.
 * Replaces native `title` tooltip with a click-to-toggle pattern.
 */
export function ExpandableText({
  text,
  as: Tag = 'span',
  clampClass,
  className = '',
}: {
  text: string;
  as?: 'span' | 'p' | 'h3' | 'h4';
  /** Tailwind clamp class to toggle, e.g. "truncate" or "line-clamp-2" */
  clampClass: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  const toggle = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  };

  return (
    <Tag
      className={`${className} ${expanded ? 'whitespace-pre-wrap break-words' : clampClass} cursor-pointer`}
      onClick={toggle}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle(e);
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      title={expanded ? undefined : text}
    >
      {text}
    </Tag>
  );
}
