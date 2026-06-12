'use client';

import { type MouseEvent, useCallback, useEffect, useState } from 'react';
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

export function SkillsDriftBanner({
  projectPath,
  summary,
  staleness,
  refreshToken = 0,
  onResolved,
}: SkillsDriftBannerProps) {
  const [drift, setDrift] = useState<DriftResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictChoices, setConflictChoices] = useState<Record<string, 'override' | 'skip'>>({});

  const handleBackdrop = useCallback((e: MouseEvent) => {
    if (e.target === e.currentTarget) setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectPath/refreshToken intentionally reset stale conflict choices.
  useEffect(() => {
    setConflictChoices({});
  }, [projectPath, refreshToken]);

  const fetchDrift = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/skills/drift-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath }),
      });
      if (!res.ok) throw new Error(`drift-check ${res.status}`);
      const data = (await res.json()) as Partial<DriftCheckResponse>;
      setDrift(data.result ?? EMPTY_DRIFT);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken is a parent-driven refetch signal.
  useEffect(() => {
    void fetchDrift();
  }, [fetchDrift, refreshToken]);

  const sync = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/skills/drift-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync', conflictChoices, projectPath }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`drift-resolve sync ${res.status} ${txt.slice(0, 80)}`);
      }
      setOpen(false);
      setConflictChoices({});
      await fetchDrift();
      await onResolved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  }, [conflictChoices, projectPath, fetchDrift, onResolved]);

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
      setOpen(false);
      await fetchDrift();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  }, [projectPath, fetchDrift]);

  const currentDrift = drift ?? EMPTY_DRIFT;
  const visibleDrift = currentDrift.isIgnored ? EMPTY_DRIFT : currentDrift;
  const driftTotal = visibleDrift.newSkills.length + visibleDrift.conflicts.length + visibleDrift.stale.length;
  const summaryIssues = [
    summary && !summary.allMounted ? '挂载不一致' : null,
    summary && !summary.registrationConsistent ? '注册不一致' : null,
    !currentDrift.isIgnored && staleness?.stale ? '有更新' : null,
  ].filter(Boolean) as string[];
  const registrationIssues = summary?.registrationIssues;
  const unregisteredSkills = registrationIssues?.unregistered ?? [];
  const phantomSkills = registrationIssues?.phantom ?? [];
  const statusIssueGroups: Array<{ label: string; skills?: string[] }> = [];
  if (summary && !summary.allMounted) {
    const mountIssueSkills = summary.mountIssues?.map((issue) => {
      const providers = issue.unmountedProviders.join(', ');
      return `${issue.skill}（${providers} 未挂载）`;
    });
    statusIssueGroups.push({ label: '挂载状态不一致', skills: mountIssueSkills });
  }
  if (summary && !summary.registrationConsistent) {
    if (unregisteredSkills.length > 0) {
      statusIssueGroups.push({ label: '注册状态不一致（未注册）', skills: unregisteredSkills });
    }
    if (phantomSkills.length > 0) {
      statusIssueGroups.push({ label: '注册状态不一致（源中不存在）', skills: phantomSkills });
    }
    if (unregisteredSkills.length === 0 && phantomSkills.length === 0) {
      statusIssueGroups.push({ label: '注册状态不一致' });
    }
  }
  if (!currentDrift.isIgnored && staleness?.stale) {
    statusIssueGroups.push({ label: '源池状态有更新' });
  }
  const total = driftTotal + summaryIssues.length;
  if (loading && !drift && total === 0) {
    return <p className="text-xs text-cafe-muted">Skill 异常检测中…</p>;
  }
  if (total === 0 || (currentDrift.isIgnored && summaryIssues.length === 0)) {
    return <p className="text-xs text-cafe-muted">✓ Skill 与源池完全同步</p>;
  }

  return (
    <div className="rounded-2xl border border-conn-amber-ring bg-conn-amber-bg shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <p className="text-sm font-bold text-conn-amber-text">⚠ 检测到 {total} 项 Skill 异常</p>
          <p className="mt-0.5 text-xs text-cafe-secondary">
            {summaryIssues.join(' · ') || '挂载正常'} · {visibleDrift.newSkills.length} 待挂载 ·{' '}
            {visibleDrift.conflicts.length} 挂载冲突 · {visibleDrift.stale.length} 残留待清
          </p>
        </div>
        <span className="text-xs text-cafe-muted">查看详情</span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--console-overlay-backdrop)] px-4 backdrop-blur-sm"
          role="dialog"
          onClick={handleBackdrop}
        >
          <div
            className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-xl bg-[var(--console-card-bg)] p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-base font-bold text-cafe">Skill 异常详情</p>
                <p className="text-xs text-cafe-secondary">当前项目存在的挂载、注册、来源和漂移问题。</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-base font-bold leading-none text-cafe-muted transition hover:bg-[var(--console-modal-close-bg)] hover:text-[var(--console-modal-close-fg)]"
              >
                ×
              </button>
            </div>

            {error && <p className="mb-2 text-xs text-conn-red-text">⚠ {error}</p>}

            {summaryIssues.length > 0 && (
              <div className="mb-3 rounded-lg bg-[var(--console-panel-bg)] p-3">
                <p className="text-xs font-semibold text-cafe-secondary">状态不一致</p>
                <ul className="mt-1 list-disc space-y-2 pl-4 text-xs text-cafe-muted">
                  {statusIssueGroups.map((group) => (
                    <li key={group.label}>
                      <span className="font-medium text-cafe-secondary">{group.label}</span>
                      {group.skills && group.skills.length > 0 && (
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-cafe-muted">
                          {group.skills.map((skill) => (
                            <li key={`${group.label}:${skill}`}>{skill}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {visibleDrift.newSkills.length > 0 && (
              <details className="mb-2" open={visibleDrift.newSkills.length <= 5}>
                <summary className="cursor-pointer text-xs font-semibold text-cafe-secondary">
                  ✨ 待挂载 ({visibleDrift.newSkills.length})
                </summary>
                <p className="mt-1 text-xs text-cafe-muted">{visibleDrift.newSkills.join(', ')}</p>
              </details>
            )}

            {visibleDrift.conflicts.length > 0 && (
              <div className="mb-2">
                <p className="text-xs font-semibold text-cafe-secondary">
                  ⚠ 挂载冲突 ({visibleDrift.conflicts.length})
                </p>
                {visibleDrift.conflicts.map((c) => {
                  const conflictKey = `${c.skill}:${c.provider}`;
                  return (
                    <div
                      key={conflictKey}
                      className="mt-1 flex items-center gap-3 rounded-xl bg-[var(--console-card-bg)] p-2 text-xs"
                    >
                      <div className="flex-1">
                        <p className="font-medium text-cafe">{c.skill}</p>
                        <p className="text-cafe-muted">
                          {c.provider} · {c.kind}
                          {c.pointsTo ? ` → ${c.pointsTo}` : ''}
                        </p>
                      </div>
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          name={`conflict-${conflictKey}`}
                          checked={conflictChoices[conflictKey] === 'skip' || !conflictChoices[conflictKey]}
                          onChange={() => setConflictChoices((m) => ({ ...m, [conflictKey]: 'skip' }))}
                        />
                        跳过
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          name={`conflict-${conflictKey}`}
                          checked={conflictChoices[conflictKey] === 'override'}
                          onChange={() => setConflictChoices((m) => ({ ...m, [conflictKey]: 'override' }))}
                        />
                        覆盖
                      </label>
                    </div>
                  );
                })}
              </div>
            )}

            {visibleDrift.stale.length > 0 && (
              <details className="mb-2" open={visibleDrift.stale.length <= 5}>
                <summary className="cursor-pointer text-xs font-semibold text-cafe-secondary">
                  🗑 残留待清 ({visibleDrift.stale.length})
                </summary>
                <p className="mt-1 text-xs text-cafe-muted">{visibleDrift.stale.join(', ')}</p>
              </details>
            )}

            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={ignore}
                disabled={busy}
                className="rounded-xl px-3 py-1.5 text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)] disabled:opacity-40"
              >
                忽略本次
              </button>
              <button
                type="button"
                onClick={sync}
                disabled={busy}
                className="rounded-xl bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:opacity-40"
              >
                {busy ? '同步中…' : '立即同步'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
