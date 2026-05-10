'use client';

import { useMemo } from 'react';
import type { RichHtmlWidgetBlock } from '@/stores/chat-types';
import { sanitizeWidgetHtml } from './sanitize-widget-html';

export function HtmlWidgetBlock({ block }: { block: RichHtmlWidgetBlock }) {
  const height = block.height ?? 300;
  const safeHtml = useMemo(() => sanitizeWidgetHtml(block.html), [block.html]);

  return (
    <div className="rounded-lg border border-[var(--console-border-soft)] overflow-hidden">
      {block.title && (
        <div className="px-3 py-1.5 text-xs font-medium text-cafe-secondary dark:text-cafe-muted bg-[var(--console-card-bg)] border-b border-[var(--console-border-soft)]">
          {block.title}
        </div>
      )}
      <iframe
        srcDoc={safeHtml}
        sandbox="allow-scripts"
        title={block.title ?? 'Interactive Widget'}
        style={{ width: '100%', height: `${height}px`, border: 'none' }}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
