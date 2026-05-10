'use client';

import { useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { RichBlock, RichCardBlock } from '@/stores/chat-types';
import { CafeIcon } from './CafeIcons';

/**
 * F148 Briefing Card: navigation-first collapsed view.
 * Collapsed: header + 3 key fields (传球/真相源/下一���) always visible.
 * Expanded: full bodyMarkdown details.
 */
export function BriefingCard({ block: raw }: { block: RichBlock; messageId?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (raw.kind !== 'card') return null;
  const block = raw as RichCardBlock;

  return (
    <div className="border-l-4 border-l-[var(--color-cafe-accent)]/60 bg-[var(--color-cafe-accent)]/5 dark:bg-[var(--color-cafe-accent)]/10 rounded-r-lg overflow-hidden">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-left hover:bg-[var(--color-cafe-accent)]/10 dark:hover:bg-[var(--color-cafe-accent)]/15 transition-colors"
      >
        <CafeIcon name="search" className="w-3.5 h-3.5 text-[var(--color-cafe-accent)] shrink-0" />
        <span className="text-[11px] font-medium text-[var(--color-cafe-accent)] uppercase tracking-wide">
          Context Briefing
        </span>
        <span className="mx-1.5 text-[var(--color-cafe-accent)]/40">·</span>
        <span className="text-sm text-cafe-secondary dark:text-cafe-muted truncate flex-1">{block.title}</span>
        <svg
          className={`w-3.5 h-3.5 text-[var(--color-cafe-accent)]/60 shrink-0 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Navigation fields — always visible */}
      {block.fields && block.fields.length > 0 && (
        <div className="px-3 pb-2 grid grid-cols-1 sm:grid-cols-3 gap-1">
          {block.fields.map((f, i) => (
            <div key={i} className="text-xs">
              <span className="text-[var(--color-cafe-accent)] font-medium">{f.label}</span>
              <span className="text-cafe-secondary dark:text-cafe-muted ml-1">{f.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Expanded: full details */}
      {expanded && block.bodyMarkdown && (
        <div className="px-3 pb-3 pt-1 border-t border-[var(--color-cafe-accent)]/20">
          <div className="text-xs text-cafe-secondary dark:text-cafe-muted [&_.markdown-content]:text-xs [&_p]:mb-1 [&_p:last-child]:mb-0">
            <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
          </div>
        </div>
      )}
    </div>
  );
}
