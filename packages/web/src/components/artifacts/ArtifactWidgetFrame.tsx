'use client';

import { useEffect, useMemo, useState } from 'react';
import type { RichHtmlWidgetBlock } from '@/stores/chat-types';
import { sanitizeWidgetHtml } from '../rich/sanitize-widget-html';

/**
 * F232 PR-A — Works 面板里的 HTML 原块预览。
 *
 * 与聊天里的 `HtmlWidgetBlock` 用同一套消毒（`sanitizeWidgetHtml`）和同一组 iframe 边界
 * （`sandbox="allow-scripts"`，无 same-origin，`no-referrer`），但不复用它的高度桥：
 * 聊天侧按聊天容器测量、`scrolling="no"`、超过 720px 收成「展开」；面板要的是
 * 「填满工作区、页面在框内自己滚动」。两套高度合同混用会让 `100vh` 形成测量闭环。
 *
 * 只渲染调用方已经按坐标、kind 校验过的块；这里不做任何「换一块顶上」的兜底。
 */
export function ArtifactWidgetFrame({ block }: { block: RichHtmlWidgetBlock }) {
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
