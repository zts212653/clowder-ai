'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-client';
import type { SkillsData } from './skills-types';

interface DriftConflict {
  skill: string;
  kind: 'other-symlink' | 'directory' | 'file';
  provider: string;
  pointsTo?: string;
}

interface DriftResult {
  newSkills: string[];
  conflicts: DriftConflict[];
  stale: string[];
  driftHash: string;
  isIgnored: boolean;
}

interface DriftCheckResponse {
  result: DriftResult;
  projectRoot: string;
}

interface SkillsDriftBannerProps {
  projectPath?: string;
  summary?: SkillsData['summary'];
  staleness?: SkillsData['staleness'];
  refreshToken?: number;
  /** Called after a successful sync/ignore so parent can refresh skill list. */
  onResolved?: () => void | Promise<void>;
}

const EMPTY_DRIFT: DriftResult = {
  newSkills: [],
  conflicts: [],
  stale: [],
  driftHash: '',
  isIgnored: false,
};

const CONFLICT_KIND_LABELS: Record<string, string> = {
  directory: '存在同名目录',
  file: '存在同名文件',
  'other-symlink': '被其他链接占用',
};

export function SkillsDriftBanner({
  projectPath,
  summary,
  staleness,
  refreshToken = 0,
  onResolved,
}: SkillsDriftBannerProps) {
  const [drift, setDrift] = useState<DriftResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await fetchDrift();
      await onResolved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  }, [projectPath, fetchDrift, onResolved]);

  const ignore = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/skills/drift-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ignore', projectPath }),
      });
      if (!res.ok) throw new Error(`drift-resolve ignore ${res.status}`);
      await fetchDrift();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  }, [projectPath, fetchDrift]);

  // --- Compute issue list ---
  const currentDrift = drift ?? EMPTY_DRIFT;
  const visibleDrift = currentDrift.isIgnored ? EMPTY_DRIFT : currentDrift;

  // Cross-reference drift conflicts with mount issues to avoid double-counting
  const conflictLookup = new Map<string, string>();
  for (const c of visibleDrift.conflicts) {
    conflictLookup.set(`${c.skill}:${c.provider}`, c.kind);
  }

  // Build flat issue list: "类型 - skillName 描述"
  const issues: string[] = [];

  // Mount issues not explained by drift conflicts
  if (summary && !summary.allMounted) {
    for (const issue of summary.mountIssues ?? []) {
      for (const provider of issue.unmountedProviders) {
        const conflictKind = conflictLookup.get(`${issue.skill}:${provider}`);
        if (!conflictKind) {
          issues.push(`挂载缺失 - ${issue.skill} ${provider} 未挂载`);
        }
      }
    }
  }

  // Registration issues (global scope only)
  const isGlobalScope = !projectPath;
  if (isGlobalScope && summary && !summary.registrationConsistent) {
    for (const name of summary.registrationIssues?.unregistered ?? []) {
      issues.push(`未注册 - ${name} 源中存在但未注册`);
    }
    for (const name of summary.registrationIssues?.phantom ?? []) {
      issues.push(`幽灵注册 - ${name} 已注册但源中不存在`);
    }
  }

  // Staleness
  if (!currentDrift.isIgnored && staleness?.stale) {
    issues.push('源池更新 - 源池状态有更新，需要同步');
  }

  // Drift: new skills
  for (const name of visibleDrift.newSkills) {
    issues.push(`待挂载 - ${name} 已注册但未挂载`);
  }

  // Drift: conflicts
  for (const c of visibleDrift.conflicts) {
    const kindLabel = CONFLICT_KIND_LABELS[c.kind] ?? c.kind;
    issues.push(`挂载冲突 - ${c.skill} ${c.provider} ${kindLabel}${c.pointsTo ? ` → ${c.pointsTo}` : ''}`);
  }

  // Drift: stale symlinks
  for (const name of visibleDrift.stale) {
    issues.push(`残留待清 - ${name} 挂载残留需清理`);
  }

  // --- Render ---
  if (loading && !drift && issues.length === 0) {
    return <p className="text-xs text-cafe-muted">Skill 异常检测中…</p>;
  }
  if (issues.length === 0) {
    return <p className="text-xs text-cafe-muted">✓ Skill 与源池完全同步</p>;
  }

  return (
    <div className="rounded-lg border border-conn-amber-ring bg-conn-amber-bg px-4 py-3">
      <p className="text-sm font-bold text-conn-amber-text">⚠ 检测到 {issues.length} 项 Skill 异常</p>

      {error && <p className="mt-1 text-xs text-conn-red-text">⚠ {error}</p>}

      <ul className="mt-2 space-y-1 text-xs text-cafe-secondary">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={sync}
          disabled={busy}
          className="rounded-lg bg-cafe-accent px-3 py-1 text-xs font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:opacity-40"
        >
          {busy ? '同步中…' : '立即同步'}
        </button>
        <button
          type="button"
          onClick={ignore}
          disabled={busy}
          className="rounded-lg px-3 py-1 text-xs text-cafe-secondary hover:text-cafe disabled:opacity-40"
        >
          忽略本次
        </button>
      </div>
    </div>
  );
}
