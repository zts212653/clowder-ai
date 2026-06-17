'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-client';
import { SkillIssueDetailDialog } from './SkillIssueDetailDialog';
import type { SkillIssue } from './skill-issue-view';

interface DriftResult {
  issues: SkillIssue[];
  driftHash: string;
}

interface DriftCheckResponse {
  result: DriftResult;
  projectRoot: string;
}

interface SkillsDriftBannerProps {
  projectPath?: string;
  refreshToken?: number;
  /** Called after a successful sync so parent can refresh the skill list. */
  onResolved?: () => void | Promise<void>;
}

const EMPTY_DRIFT: DriftResult = { issues: [], driftHash: '' };

export function SkillsDriftBanner({ projectPath, refreshToken = 0, onResolved }: SkillsDriftBannerProps) {
  const [drift, setDrift] = useState<DriftResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  const fetchDrift = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch('/api/skills/drift-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath }),
          signal,
        });
        if (signal?.aborted) return;
        if (!res.ok) throw new Error(`drift-check ${res.status}`);
        const data = (await res.json()) as Partial<DriftCheckResponse>;
        if (signal?.aborted) return;
        setDrift(data.result ?? EMPTY_DRIFT);
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'unknown error');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectPath],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken is a parent-driven refetch signal.
  useEffect(() => {
    const controller = new AbortController();
    void fetchDrift(controller.signal);
    return () => controller.abort();
  }, [fetchDrift, refreshToken]);

  const sync = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/skills/drift-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync', projectPath }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`drift-resolve sync ${res.status} ${txt.slice(0, 80)}`);
      }
      setShowDetail(false);
      await fetchDrift();
      await onResolved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  }, [projectPath, fetchDrift, onResolved]);

  const current = drift ?? EMPTY_DRIFT;
  const issues = current.issues ?? [];

  if (loading && !drift && issues.length === 0) {
    return <p className="text-xs text-cafe-muted">Skill 异常检测中…</p>;
  }
  if (issues.length === 0) {
    return <p className="text-xs text-cafe-muted">✓ Skill 与源池完全同步</p>;
  }

  return (
    <div className="rounded-lg border border-conn-amber-ring bg-conn-amber-bg px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-bold text-conn-amber-text">检测到 {issues.length} 项 Skill 异常</p>
        <button
          type="button"
          onClick={() => setShowDetail(true)}
          className="text-xs font-semibold text-cafe-accent hover:underline"
        >
          查看详情
        </button>
      </div>

      {error && <p className="mt-1 text-xs text-conn-red-text">⚠ {error}</p>}

      {showDetail && (
        <SkillIssueDetailDialog issues={issues} syncing={busy} onSync={sync} onClose={() => setShowDetail(false)} />
      )}
    </div>
  );
}
