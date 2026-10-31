'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { AppTooltip } from './AppTooltip';
import { composerContextCopy } from './composer-context.shell-copy';
import { useShellCopy } from './shell/shell-copy';

type Strategy = 'resume' | 'reborn';
const classicCopy = {
  ...composerContextCopy.zh,
  resumeHint: 'Resume: 延续之前的会话，注入 bootstrap 摘要',
  rebornHint: 'Reborn: 每次调用都是全新会话，不注入历史上下文',
};

interface MemberSessionStrategyProps {
  threadId: string;
  catId: string;
  presentation?: 'header' | 'composer';
}

/**
 * #921: Per-member session strategy control (resume / reborn).
 * Shown inline within the cat selector popover for the active thread.
 *
 * - resume (default): continues from last session, injects bootstrap digest
 * - reborn: fresh session every invocation, no continuation, no bootstrap
 */
export function MemberSessionStrategy({ threadId, catId, presentation = 'header' }: MemberSessionStrategyProps) {
  const localized = useShellCopy(composerContextCopy);
  const isComposer = presentation === 'composer';
  const copy = isComposer ? localized : classicCopy;
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
        <span className="text-cafe-secondary font-medium">{copy.sessionStrategy}</span>
        <span className="text-micro text-cafe-muted truncate">{strategy === 'reborn' ? copy.reborn : copy.resume}</span>
      </div>
      <AppTooltip
        label={strategy === 'reborn' ? copy.rebornHint : copy.resumeHint}
        side="top"
        multiline
        disabled={!isComposer}
      >
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={saving}
          className={`flex-shrink-0 px-2 py-0.5 rounded text-xs font-medium transition-colors ${
            strategy === 'reborn'
              ? 'bg-conn-amber-surface text-conn-amber-text'
              : 'bg-cafe-surface-elevated text-cafe-secondary hover:text-cafe'
          } disabled:opacity-50`}
          title={isComposer ? undefined : strategy === 'reborn' ? copy.rebornHint : copy.resumeHint}
        >
          {saving ? '...' : strategy === 'reborn' ? 'Reborn' : 'Resume'}
        </button>
      </AppTooltip>
    </div>
  );
}
