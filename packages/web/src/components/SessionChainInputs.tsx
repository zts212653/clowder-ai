/**
 * Sub-components for SessionChainPanel: BindSessionInput + SessionIdTag.
 * Extracted to keep SessionChainPanel under 350 lines.
 */

// biome-ignore lint/correctness/noUnusedImports: React needed for JSX in vitest environment
import React, { useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { apiFetch } from '@/utils/api-client';
import { truncateId } from './status-helpers';

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
        className="text-[9px] text-cafe-muted hover:text-cafe-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        bind...
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
        placeholder="CLI session ID"
        maxLength={500}
        className="flex-1 text-[10px] font-mono px-1.5 py-0.5 rounded border border-cafe bg-cafe-surface-elevated focus:outline-none focus:ring-1 focus:ring-cocreator-primary"
        // biome-ignore lint/a11y/noAutofocus: intentional UX — focus input immediately on open
        autoFocus
      />
      <button
        type="button"
        onClick={() => void handleBind()}
        disabled={status === 'saving' || !value.trim() || disabled}
        className="text-[9px] px-1.5 py-0.5 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-40 transition-colors"
      >
        {status === 'saving' ? '...' : status === 'ok' ? 'ok' : status === 'error' ? 'err' : 'bind'}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setStatus('idle');
        }}
        className="text-[9px] text-cafe-muted hover:text-cafe-secondary"
      >
        ✕
      </button>
    </div>
  );
}

export function SessionIdTag({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button
      type="button"
      className="text-[9px] font-mono text-cafe-muted hover:text-cafe-secondary cursor-pointer transition-colors"
      title={`点击复制: ${id}`}
      onClick={handleCopy}
    >
      {copied ? 'copied!' : truncateId(id, 10)}
    </button>
  );
}
