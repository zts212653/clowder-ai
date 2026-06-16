'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

type Strategy = 'resume' | 'reborn';

interface MemberSessionStrategyProps {
  threadId: string;
  catId: string;
}

/**
 * #921: Per-member session strategy control (resume / reborn).
 * Shown inline within the cat selector popover for the active thread.
 *
 * - resume (default): continues from last session, injects bootstrap digest
 * - reborn: fresh session every invocation, no continuation, no bootstrap
 */
export function MemberSessionStrategy({ threadId, catId }: MemberSessionStrategyProps) {
  const [strategy, setStrategy] = useState<Strategy>('resume');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Hide the control entirely when the API denies access (shared default
  // thread, system-indexed threads, or any future access restriction).
  const [accessible, setAccessible] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setAccessible(true);
    apiFetch(`/api/threads/${threadId}/members/${catId}/session-strategy`)
      .then((res) => {
        if (!res.ok) {
          if (!cancelled) setAccessible(false);
          return undefined;
        }
        return res.json();
      })
      .then((data?: { strategy?: Strategy }) => {
        if (!cancelled && data) setStrategy(data.strategy ?? 'resume');
      })
      .catch(() => {
        if (!cancelled) setAccessible(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, catId]);

  const toggle = useCallback(async () => {
    const next: Strategy = strategy === 'resume' ? 'reborn' : 'resume';
    setSaving(true);
    try {
      const res = await apiFetch(`/api/threads/${threadId}/members/${catId}/session-strategy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: next }),
      });
      if (res.ok) setStrategy(next);
    } finally {
      setSaving(false);
    }
  }, [threadId, catId, strategy]);

  if (loading || !accessible) return null;

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs border-t border-cafe-subtle">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-cafe-secondary font-medium">会话策略</span>
        <span className="text-micro text-cafe-muted truncate">
          {strategy === 'reborn' ? '每次新建会话（无上下文延续）' : '延续上次会话'}
        </span>
      </div>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={saving}
        className={`flex-shrink-0 px-2 py-0.5 rounded text-xs font-medium transition-colors ${
          strategy === 'reborn'
            ? 'bg-conn-amber-surface text-conn-amber-text'
            : 'bg-cafe-surface-elevated text-cafe-secondary hover:text-cafe'
        } disabled:opacity-50`}
        title={
          strategy === 'reborn'
            ? 'Reborn: 每次调用都是全新会话，不注入历史上下文'
            : 'Resume: 延续之前的会话，注入 bootstrap 摘要'
        }
      >
        {saving ? '...' : strategy === 'reborn' ? 'Reborn' : 'Resume'}
      </button>
    </div>
  );
}
