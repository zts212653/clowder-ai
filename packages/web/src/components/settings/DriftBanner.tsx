'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { DriftCheckResult, DriftIssue, DriftType } from './drift-types';
import { DRIFT_ISSUE_LABELS, driftTypeLabel } from './drift-types';
import { ModalOverlay } from './skill-issue-view';

// ── DriftIssueList (shared issue renderer) ──────────────────────────────────

/** Group a flat issue list by id (skill name / mcpId), preserving backend order. */
function groupIssuesById(issues: DriftIssue[]): Array<{ id: string; items: DriftIssue[] }> {
  const map = new Map<string, DriftIssue[]>();
  for (const issue of issues) {
    const list = map.get(issue.id);
    if (list) list.push(issue);
    else map.set(issue.id, [issue]);
  }
  return Array.from(map, ([id, items]) => ({ id, items }));
}

/** Render drift issues grouped by identifier. Works for both Skill and MCP. */
export function DriftIssueList({ issues }: { issues: DriftIssue[] }) {
  const grouped = groupIssuesById(issues);
  if (grouped.length === 0) {
    return <p className="text-xs text-cafe-muted">✓ 无异常</p>;
  }
  return (
    <ul className="space-y-1.5">
      {grouped.map(({ id, items }) => (
        <li key={id}>
          <p className="font-medium text-cafe">{id}</p>
          <ul className="ml-3 mt-0.5 space-y-0.5">
            {items.map((item) => (
              <li key={`${item.issueType}:${item.mountPoint ?? ''}`} className="flex items-start gap-2">
                <span className="shrink-0 font-semibold text-conn-amber-text">
                  {DRIFT_ISSUE_LABELS[item.issueType] ?? item.issueType}
                </span>
                <span className="text-cafe-muted">{item.message}</span>
                {item.hasOverride && (
                  <span className="ml-auto text-cafe-muted" title="项目有自定义配置">
                    ✎
                  </span>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

// ── DriftIssueDetailDialog ──────────────────────────────────────────────────

function DriftIssueDetailDialog({
  type,
  issues,
  syncing,
  onSync,
  onClose,
}: {
  type: DriftType;
  issues: DriftIssue[];
  syncing: boolean;
  onSync: () => void;
  onClose: () => void;
}) {
  return (
    <ModalOverlay onClose={onClose}>
      <div className="flex shrink-0 items-center justify-between">
        <h3 className="text-sm font-bold text-cafe">{driftTypeLabel(type)} 异常详情</h3>
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-cafe-muted hover:text-cafe"
        >
          ×
        </button>
      </div>

      <section className="mt-3 min-h-0 flex-1 overflow-y-auto text-xs">
        {issues.length > 0 ? <DriftIssueList issues={issues} /> : <p className="text-cafe-muted">暂无异常。</p>}
      </section>

      <div className="mt-4 flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onSync}
          disabled={syncing}
          className="rounded-lg bg-cafe-accent px-3 py-1 text-xs font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:opacity-40"
        >
          {syncing ? '同步中…' : '立即同步'}
        </button>
      </div>
    </ModalOverlay>
  );
}

// ── DriftBanner (single project — unified) ──────────────────────────────────

interface DriftBannerProps {
  /** 'skill' or 'mcp'. */
  type: DriftType;
  projectPath?: string;
  refreshToken?: number;
  onResolved?: () => void | Promise<void>;
}

/**
 * Unified single-project drift banner — replaces both SkillsDriftBanner and
 * McpDriftBanner. Same endpoint, same UI, parameterized by `type`.
 */
export function DriftBanner({ type, projectPath, refreshToken = 0, onResolved }: DriftBannerProps) {
  const [drift, setDrift] = useState<DriftCheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const fetchGen = useRef(0);

  const fetchDrift = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++fetchGen.current;
      const isCurrent = () => fetchGen.current === generation;
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch('/api/drift/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, projectPath }),
          signal,
        });
        if (signal?.aborted || !isCurrent()) return;
        if (!res.ok) throw new Error(`drift-check ${res.status}`);
        const data = (await res.json()) as { result: DriftCheckResult };
        if (signal?.aborted || !isCurrent()) return;
        setDrift(data.result ?? { issues: [], driftHash: '' });
      } catch (err) {
        if (signal?.aborted) return;
        if (!isCurrent()) return;
        setError(err instanceof Error ? err.message : 'unknown error');
      } finally {
        if (!signal?.aborted && fetchGen.current === generation) setLoading(false);
      }
    },
    [type, projectPath],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken is a parent-driven refetch signal.
  useEffect(() => {
    const controller = new AbortController();
    void fetchDrift(controller.signal);
    return () => controller.abort();
  }, [fetchDrift, refreshToken]);

  const sync = useCallback(async () => {
    // MCP-specific: confirm orphan removal before syncing
    if (type === 'mcp') {
      const orphans = (drift?.issues ?? []).filter((i) => i.issueType === 'project-orphan');
      if (orphans.length > 0) {
        const names = orphans.map((o) => `「${o.id}」`).join('、');
        if (!window.confirm(`以下 MCP 在全局已不存在，同步将移除它们：\n${names}\n\n确认移除？`)) {
          return;
        }
      }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/drift/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, action: 'sync', projectPath }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`drift-resolve ${res.status} ${txt.slice(0, 80)}`);
      }
      setShowDetail(false);
      await fetchDrift();
      await onResolved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  }, [type, projectPath, fetchDrift, onResolved, drift]);

  const label = driftTypeLabel(type);
  const issues = drift?.issues ?? [];

  if (loading && !drift && issues.length === 0) {
    return <p className="text-xs text-cafe-muted">{label} 配置检测中…</p>;
  }
  if (issues.length === 0) {
    return (
      <p className="text-xs text-cafe-muted">✓ {type === 'skill' ? 'Skill 与源池完全同步' : 'MCP 配置与全局同步'}</p>
    );
  }

  return (
    <div className="rounded-lg border border-conn-amber-ring bg-conn-amber-bg px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-bold text-conn-amber-text">
          发现 {issues.length} 项 {label} {type === 'skill' ? '异常' : '配置漂移'}
        </p>
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
        <DriftIssueDetailDialog
          type={type}
          issues={issues}
          syncing={busy}
          onSync={sync}
          onClose={() => setShowDetail(false)}
        />
      )}
    </div>
  );
}
