'use client';

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface PageChoice {
  pageId: string;
  title: string;
  url: string;
}
const ROUTE = '/api/concierge/page-action';

/** Explicitly picking a page permits bounded control-label projection to Jev, never a write. */
export function OwnerCurrentPagePicker({
  requestMessageId,
  disabled,
  onSelected,
}: {
  requestMessageId: string;
  disabled: boolean;
  onSelected: () => Promise<void>;
}) {
  const [pages, setPages] = useState<PageChoice[] | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = async () => {
    if (disabled || working) return;
    setWorking(true);
    setPages(null);
    setError(null);
    try {
      const response = await apiFetch(`${ROUTE}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestMessageId }),
      });
      if (!response.ok) throw new Error('Browser unavailable');
      setPages(((await response.json()) as { pages: PageChoice[] }).pages);
      await onSelected();
    } catch {
      setError('浏览器连接或当前请求不可用，请重新连接后选择。');
    } finally {
      setWorking(false);
    }
  };
  const choose = async (pageId: string) => {
    if (disabled || working) return;
    setWorking(true);
    setError(null);
    try {
      const response = await apiFetch(`${ROUTE}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestMessageId, pageId }),
      });
      if (!response.ok) throw new Error('Page changed');
      setPages(null);
    } catch {
      setError('页面、控件或请求已变化；尚未修改页面，请重新选择。');
    } finally {
      await onSelected();
      setWorking(false);
    }
  };
  return (
    <div className="mt-1 space-y-1">
      <p>从已连接的浏览器列出页面标题与网址，选定后再检查控件。</p>
      <button
        type="button"
        disabled={disabled || working}
        onClick={() => void list()}
        className="rounded border border-cafe-divider px-2 py-1 disabled:opacity-50"
      >
        {working ? '读取中…' : '选择当前页面'}
      </button>
      {pages && (
        <section aria-label="选择浏览器页面" className="space-y-1 rounded border border-cafe-divider p-2">
          <p>选择后只检查该页当前可见的按钮和文本框，控件标签交给 Jev 选择目标。不会读取其他页面正文或立即修改。</p>
          {pages.length === 0 && <p>当前连接中没有可选页面。</p>}
          {pages.map((page) => (
            <button
              key={page.pageId}
              type="button"
              disabled={disabled || working}
              onClick={() => void choose(page.pageId)}
              className="block w-full rounded border border-cafe-divider p-2 text-left disabled:opacity-50"
            >
              <span className="block">{page.title || '无标题页面'}</span>
              <span className="block break-all">{page.url}</span>
            </button>
          ))}
          <button type="button" onClick={() => setPages(null)}>
            取消选页
          </button>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
