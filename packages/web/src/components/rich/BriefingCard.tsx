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
    <div className="border-l-4 border-l-blue-400 bg-blue-50 dark:bg-blue-950/30 rounded-r-lg overflow-hidden">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-left hover:bg-blue-100/50 dark:hover:bg-blue-900/30 transition-colors"
      >
        <CafeIcon name="search" className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400 shrink-0" />
        <span className="text-[11px] font-medium text-blue-600 dark:text-blue-300 uppercase tracking-wide">
          Context Briefing
        </span>
        <span className="mx-1.5 text-blue-300 dark:text-blue-600">·</span>
        <span className="text-sm text-cafe-secondary dark:text-gray-300 truncate flex-1">{block.title}</span>
        <svg
          className={`w-3.5 h-3.5 text-blue-400 shrink-0 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
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
              <span className="text-blue-500 dark:text-blue-400 font-medium">{f.label}</span>
              <span className="text-cafe-secondary dark:text-gray-400 ml-1">{f.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Expanded: full details */}
      {expanded && block.bodyMarkdown && (
        <div className="px-3 pb-3 pt-1 border-t border-blue-200/50 dark:border-blue-800/50">
          <div className="text-xs text-cafe-secondary dark:text-gray-300 [&_.markdown-content]:text-xs [&_p]:mb-1 [&_p:last-child]:mb-0">
            <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
          </div>
        </div>
      )}
    </div>
  );
}
