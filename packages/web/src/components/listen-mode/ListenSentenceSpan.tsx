'use client';

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

interface ListenSentenceSpanProps {
  anchor: string;
  index: number;
  active: boolean;
  onStart: (index: number) => void;
  children: ReactNode;
}

function hasSelectedText(): boolean {
  return Boolean(window.getSelection()?.toString().trim());
}

export function ListenSentenceSpan({ anchor, index, active, onStart, children }: ListenSentenceSpanProps) {
  const handleClick = (event: MouseEvent<HTMLSpanElement>) => {
    if (hasSelectedText()) return;
    event.stopPropagation();
    onStart(index);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    onStart(index);
  };

  return (
    <span
      role="button"
      tabIndex={0}
      data-listen-sentence-anchor={anchor}
      data-listen-sentence-index={index}
      aria-label={`从第 ${index + 1} 句开始听读`}
      aria-current={active ? 'true' : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`cursor-pointer rounded-sm px-0.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--cafe-accent)] ${
        active
          ? '[background:color-mix(in_oklch,var(--cafe-accent)_18%,transparent)] text-cafe'
          : 'hover:[background:color-mix(in_oklch,var(--cafe-accent)_8%,transparent)]'
      }`}
    >
      {children}
    </span>
  );
}
