/**
 * F33: Bind an external CLI session to a cat that has no active session in this thread yet.
 * Extracted from SessionChainPanel to keep file size under 350 lines.
 */

// biome-ignore lint/correctness/noUnusedImports: React needed for JSX in vitest environment
import React, { useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { apiFetch } from '@/utils/api-client';

export interface BindNewSessionSectionProps {
  threadId: string;
  activeCatIds: Set<string>;
  onBound: () => void;
  disabled?: boolean;
}

export function BindNewSessionSection({ threadId, activeCatIds, onBound, disabled }: BindNewSessionSectionProps) {
  const { cats } = useCatData();
  const [expanded, setExpanded] = useState(false);
  const [selectedCat, setSelectedCat] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'ok' | 'error'>('idle');
  const ime = useIMEGuard();

  // Cats that don't yet have an active session in this thread
  const availableCats = cats.filter((c) => !activeCatIds.has(c.id));

  const handleBind = async () => {
    if (disabled) return;
    const trimmed = sessionId.trim();
    if (!trimmed || !selectedCat || status === 'saving') return;
    setStatus('saving');
    try {
      const res = await apiFetch(`/api/threads/${threadId}/sessions/${selectedCat}/bind`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cliSessionId: trimmed }),
      });
      if (!res.ok) {
        setStatus('error');
        return;
      }
      setStatus('ok');
      setSessionId('');
      setSelectedCat('');
      setTimeout(() => {
        setExpanded(false);
        setStatus('idle');
        onBound();
      }, 800);
    } catch {
      setStatus('error');
    }
  };

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        disabled={disabled}
        className="text-[10px] text-cafe-muted hover:text-cafe-secondary transition-colors mt-1 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        + 绑定外部 Session
      </button>
    );
  }

  return (
    <div className="mt-2 p-2 rounded border border-dashed border-cafe bg-cafe-surface">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-medium text-cafe-secondary">绑定外部 Session</span>
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            setStatus('idle');
          }}
          className="text-[9px] text-cafe-muted hover:text-cafe-secondary"
        >
          ✕
        </button>
      </div>
      <div className="space-y-1.5">
        <select
          value={selectedCat}
          onChange={(e) => setSelectedCat(e.target.value)}
          className="w-full text-[11px] px-2 py-1 rounded border border-cafe bg-cafe-surface-elevated focus:outline-none focus:ring-1 focus:ring-cocreator-primary"
        >
          <option value="">选择猫猫...</option>
          {availableCats.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {formatCatName(cat)}
            </option>
          ))}
        </select>
        <input
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            if (ime.isComposing()) return;
            if (e.key === 'Enter') void handleBind();
          }}
          placeholder="CLI Session ID"
          maxLength={500}
          className="w-full text-[11px] font-mono px-2 py-1 rounded border border-cafe bg-cafe-surface-elevated focus:outline-none focus:ring-1 focus:ring-cocreator-primary"
        />
        <button
          type="button"
          onClick={() => void handleBind()}
          disabled={status === 'saving' || !sessionId.trim() || !selectedCat || disabled}
          className="w-full text-[10px] px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-40 transition-colors"
        >
          {status === 'saving'
            ? '绑定中...'
            : status === 'ok'
              ? '已绑定'
              : status === 'error'
                ? '绑定失败，重试'
                : '绑定'}
        </button>
      </div>
    </div>
  );
}
