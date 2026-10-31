'use client';

import { useEffect, useMemo, useState } from 'react';
import type { RichHtmlWidgetBlock } from '@/stores/chat-types';
import { sanitizeWidgetHtml } from './sanitize-widget-html';

export function WorkspaceHtmlWidgetBlock({ block }: { block: RichHtmlWidgetBlock }) {
  // 消毒依赖 DOM；挂载后再产出 srcDoc，避免 SSR 与客户端首帧不一致。
  const [browserReady, setBrowserReady] = useState(false);
  useEffect(() => setBrowserReady(true), []);
  const html = useMemo(() => (browserReady ? sanitizeWidgetHtml(block.html) : null), [block.html, browserReady]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-artifact-widget-frame data-artifact-widget-block={block.id}>
      {html === null ? (
        <output
          aria-label={block.title ?? 'HTML 预览'}
          className="grid flex-1 place-items-center bg-cafe-surface px-4 text-xs text-cafe-secondary"
        >
          正在准备完整内容…
        </output>
      ) : (
        <iframe
          title={block.title ?? 'HTML 预览'}
          srcDoc={html}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-white"
        />
      )}
    </div>
  );
}
