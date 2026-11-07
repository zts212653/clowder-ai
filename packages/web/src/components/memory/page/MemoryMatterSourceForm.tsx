'use client';
import type { MatterSourceInput } from '@cat-cafe/shared';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export function MemoryMatterSourceForm({
  submit,
  cancel,
  busy,
}: {
  submit: (source: MatterSourceInput) => void;
  cancel: () => void;
  busy: boolean;
}) {
  const [url, setUrl] = useState('');
  const [quote, setQuote] = useState('');
  const [error, setError] = useState('');
  const [resolving, setResolving] = useState(false);
  const resolve = async () => {
    setError('');
    setResolving(true);
    try {
      const link = new URL(url, window.location.origin);
      const threadId = /^\/thread\/([^/]+)$/.exec(link.pathname)?.[1];
      const messageId = link.searchParams.get('message');
      if (!threadId || !messageId) {
        setError('请粘贴指向原消息的链接。');
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
      submit(body.source);
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
        消息链接
        <input
          required
          aria-label="消息链接"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className="mt-1 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
        />
      </label>
      <label className="block">
        引用原文
        <textarea
          required
          maxLength={8000}
          aria-label="引用原文"
          value={quote}
          onChange={(event) => setQuote(event.target.value)}
          className="mt-1 min-h-24 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
        />
      </label>
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
