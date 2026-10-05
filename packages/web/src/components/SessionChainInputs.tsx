/**
 * Sub-components for SessionChainPanel: BindSessionInput + SessionIdTag.
 * Extracted to keep SessionChainPanel under 350 lines.
 */

// biome-ignore lint/correctness/noUnusedImports: React needed for JSX in vitest environment
import React, { useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { apiFetch } from '@/utils/api-client';
export function BindSessionInput({
  threadId,
  catId,
  onBound,
  disabled,
}: {
  threadId: string;
  catId: string;
  onBound: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'ok' | 'error'>('idle');
  const ime = useIMEGuard();

  const handleBind = async () => {
    if (disabled) return;
    const trimmed = value.trim();
    if (!trimmed || status === 'saving') return;
    setStatus('saving');
    try {
      const res = await apiFetch(`/api/threads/${threadId}/sessions/${catId}/bind`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cliSessionId: trimmed }),
      });
      if (!res.ok) {
        setStatus('error');
        return;
      }
      setStatus('ok');
      setValue('');
      setTimeout(() => {
        setOpen(false);
        setStatus('idle');
        onBound();
      }, 800);
    } catch {
      setStatus('error');
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="text-xs text-cafe-muted hover:text-cafe-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        绑定会话 ID…
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 mt-1">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
        onKeyDown={(e) => {
          if (ime.isComposing()) return;
          if (e.key === 'Enter') void handleBind();
          if (e.key === 'Escape') {
            setOpen(false);
            setStatus('idle');
          }
        }}
        placeholder="命令行会话 ID"
        maxLength={500}
        className="flex-1 text-xs font-mono px-1.5 py-0.5 rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] focus:outline-none focus:ring-1 focus:ring-cafe-accent"
        // biome-ignore lint/a11y/noAutofocus: intentional UX — focus input immediately on open
        autoFocus
      />
      <button
        type="button"
        onClick={() => void handleBind()}
        disabled={status === 'saving' || !value.trim() || disabled}
        className="text-xs px-1.5 py-0.5 rounded bg-cafe-surface hover:bg-[var(--console-hover-bg)] disabled:opacity-40 transition-colors"
      >
        {status === 'saving' ? '...' : status === 'ok' ? '已绑定' : status === 'error' ? '失败，重试' : '绑定'}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setStatus('idle');
        }}
        className="text-micro text-cafe-muted hover:text-cafe-secondary"
      >
        ✕
      </button>
    </div>
  );
}

export function SessionIdTag({ id, label = '会话 ID' }: { id: string; label?: string }) {
  const [copyResult, setCopyResult] = useState<{ id: string; state: 'copied' | 'failed' } | null>(null);
  const copyState = copyResult?.id === id ? copyResult.state : 'idle';
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopyResult({ id, state: 'copied' });
    } catch {
      setCopyResult({ id, state: 'failed' });
    }
  };
  return (
    <button
      type="button"
      className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-mono text-cafe-muted hover:text-cafe-secondary cursor-pointer transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
      title={`点击复制完整${label}: ${id}`}
      aria-label={`复制${label}：${id}`}
      onClick={() => void handleCopy()}
    >
      <span className="min-w-0 truncate">{id}</span>
      <span role="status" aria-live="polite" className="shrink-0 font-sans">
        {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败，重试' : ''}
      </span>
    </button>
  );
}
