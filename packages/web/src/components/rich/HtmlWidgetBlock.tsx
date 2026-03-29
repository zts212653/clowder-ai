'use client';

import type { RichHtmlWidgetBlock } from '@/stores/chat-types';

export function HtmlWidgetBlock({ block }: { block: RichHtmlWidgetBlock }) {
  const height = block.height ?? 300;

  return (
    <div className="rounded-lg border border-cafe dark:border-gray-700 overflow-hidden">
      {block.title && (
        <div className="px-3 py-1.5 text-xs font-medium text-cafe-secondary dark:text-gray-400 bg-cafe-surface-elevated dark:bg-gray-800 border-b border-cafe dark:border-gray-700">
          {block.title}
        </div>
      )}
      <iframe
        srcDoc={block.html}
        sandbox="allow-scripts"
        title={block.title ?? 'Interactive Widget'}
        style={{ width: '100%', height: `${height}px`, border: 'none' }}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
