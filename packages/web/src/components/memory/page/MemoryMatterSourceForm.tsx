'use client';
import type { MatterEntryView, MatterSourceInput, MatterWriteSourceInput } from '@cat-cafe/shared';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { matterSourceHref } from './MatterEntryContent';

export function MemoryMatterSourceForm({
  submit,
  cancel,
  busy,
  entry,
}: {
  submit: (change: { source: MatterWriteSourceInput; summary?: string }) => void;
  cancel: () => void;
  busy: boolean;
  entry?: MatterEntryView;
}) {
  const [url, setUrl] = useState(entry ? matterSourceHref(entry.source) : '');
  const [summary, setSummary] = useState(entry?.summary ?? '');
  const [quote, setQuote] = useState(entry?.quote ?? '');
  const [error, setError] = useState('');
  const [resolving, setResolving] = useState(false);
  const resolve = async () => {
    setError('');
    setResolving(true);
    try {
      const link = new URL(url, window.location.origin);
      const threadId = /^\/thread\/([^/]+)$/.exec(link.pathname)?.[1];
      const messageId = link.searchParams.get('message');
      if (!threadId) {
        setError('请粘贴原对话链接，知道具体消息时可带消息位置。');
        return;
      }
      if (!quote.length) {
        if (!summary.trim()) {
          setError('请写一句归纳，或附一段逐字引用。');
          return;
        }
        submit({
          source: { threadId: decodeURIComponent(threadId), ...(messageId ? { messageId } : {}) },
          summary: summary.trim(),
        });
        return;
      }
      if (!messageId) {
        setError('逐字引用需要具体消息链接；只记归纳时不必填写引用。');
        return;
      }
      if (entry?.quote === quote && url === matterSourceHref(entry.source) && !('kind' in entry.source)) {
        const { threadId, messageId, segment, start, end, contentBlockIndex, attachmentId } = entry.source;
        submit({
          source: {
            threadId,
            messageId,
            segment,
            start,
            end,
            quote,
            ...(contentBlockIndex !== undefined ? { contentBlockIndex } : {}),
            ...(attachmentId ? { attachmentId } : {}),
          },
          ...(summary.trim() ? { summary: summary.trim() } : {}),
        });
        return;
      }
      const response = await apiFetch('/api/memory/matters/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: decodeURIComponent(threadId), messageId, quote }),
      });
      if (!response.ok) {
        setError(response.status === 404 ? '原消息已不可用。' : '无法唯一匹配这段原话，请从原消息重新复制完整片段。');
        return;
      }
      const body = (await response.json()) as { source: MatterSourceInput };
      submit({ source: body.source, ...(summary.trim() ? { summary: summary.trim() } : {}) });
    } catch {
      setError('暂时无法读取原消息，请重试。');
    } finally {
      setResolving(false);
    }
  };
  return (
    <form
      className="space-y-3 rounded-lg border border-cafe-subtle p-4 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void resolve();
      }}
    >
      <label className="block">
        对话或消息链接
        <input
          required
          aria-label="对话或消息链接"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className="mt-1 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
        />
      </label>
      <label className="block">
        归纳（非原话）
        <textarea
          maxLength={4000}
          aria-label="归纳（非原话）"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          className="mt-1 min-h-24 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
        />
      </label>
      <details open={Boolean(entry?.quote)}>
        <summary className="shell-focusable cursor-pointer">附逐字引用（可选）</summary>
        <label className="block">
          引用原文（可选）
          <textarea
            maxLength={8000}
            aria-label="引用原文"
            value={quote}
            onChange={(event) => setQuote(event.target.value)}
            className="mt-1 min-h-24 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
          />
        </label>
        {entry?.quote && <p className="text-xs text-cafe-muted">保留引用时只改归纳即可；清空引用会移除本条摘录。</p>}
      </details>
      {error && (
        <p role="alert" className="text-cafe-muted">
          {error}
        </p>
      )}
      <button type="submit" className="shell-focusable mr-4 text-cafe-accent underline" disabled={busy || resolving}>
        {resolving ? '正在核对…' : '保存来源'}
      </button>
      <button type="button" className="shell-focusable text-cafe-muted" disabled={busy || resolving} onClick={cancel}>
        取消
      </button>
    </form>
  );
}
