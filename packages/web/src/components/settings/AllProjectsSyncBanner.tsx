'use client';

import { useState } from 'react';
import { DriftIssueList } from './DriftBanner';
import type { DriftType, ScopeIssues } from './drift-types';
import { driftTypeLabel } from './drift-types';
import { ModalOverlay } from './skill-issue-view';

export type { ScopeIssues } from './drift-types';

/**
 * AllProjectsSyncBanner — "全部 X" tab cross-scope anomaly banner.
 *
 * F228→F249: Unified for both Skills and MCP. Shows a tree of scopes
 * (/global + each /project), each listing its backend-computed issues.
 * The `type` prop controls display labels only — data shape is identical.
 */
export function AllProjectsSyncBanner({
  type,
  scopes,
  scopesWithIssues,
  syncing,
  error,
  onSyncAll,
  onSyncScope,
}: {
  /** 'skill' or 'mcp' — controls display labels. */
  type: DriftType;
  scopes: ScopeIssues[];
  scopesWithIssues: ScopeIssues[];
  syncing: boolean;
  error: string | null;
  onSyncAll: () => void;
  onSyncScope?: (projectPath?: string) => void;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const issueScopeCount = scopesWithIssues.length;
  const label = driftTypeLabel(type);

  if (scopes.length === 0) {
    return <p className="text-xs text-cafe-muted">未发现项目</p>;
  }
  if (issueScopeCount === 0) {
    return <p className="text-xs text-cafe-muted">✓ 全部 {label} 同步一致</p>;
  }

  return (
    <div className="rounded-lg border border-conn-amber-ring bg-conn-amber-bg px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-bold text-conn-amber-text">
          检测到 {issueScopeCount} 处 {label} 异常
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
        <AllProjectsIssueDetailDialog
          type={type}
          scopes={scopesWithIssues}
          syncing={syncing}
          onClose={() => setShowDetail(false)}
          onSyncAll={onSyncAll}
          onSyncScope={onSyncScope}
        />
      )}
    </div>
  );
}

function AllProjectsIssueDetailDialog({
  type,
  scopes,
  syncing,
  onClose,
  onSyncAll,
  onSyncScope,
}: {
  type: DriftType;
  scopes: ScopeIssues[];
  syncing: boolean;
  onClose: () => void;
  onSyncAll: () => void;
  onSyncScope?: (projectPath?: string) => void;
}) {
  const label = driftTypeLabel(type);
  // Per-scope collapse state — scopes start expanded so anomalies are visible,
  // and each can be folded away once handled.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <ModalOverlay onClose={onClose} maxWidthClass="max-w-2xl">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-cafe">项目 {label} 异常详情</h3>
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-cafe-muted hover:text-cafe"
        >
          ×
        </button>
      </div>

      <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto text-xs">
        {scopes.length === 0 && <p className="text-cafe-muted">暂无 {label} 异常详情。</p>}

        {scopes.map((scope) => {
          const isOpen = !collapsed.has(scope.key);
          return (
            <section key={scope.key} className="rounded-lg bg-[var(--console-card-bg)]">
              <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => toggle(scope.key)}
                  aria-expanded={isOpen}
                  className="flex items-center gap-1.5 font-semibold text-cafe hover:text-cafe-accent"
                >
                  <span className="text-cafe-muted">{isOpen ? '▾' : '▸'}</span>
                  {scope.label}
                  <span className="text-cafe-muted">（{scope.issues.length}）</span>
                </button>
                {onSyncScope && (
                  <button
                    type="button"
                    onClick={() => onSyncScope(scope.path)}
                    disabled={syncing}
                    className="text-xs font-semibold text-cafe-accent hover:underline disabled:opacity-50"
                  >
                    同步
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="px-2 pb-2 pl-6">
                  <DriftIssueList issues={scope.issues} />
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="mt-4 shrink-0">
        <button
          type="button"
          onClick={onSyncAll}
          disabled={syncing}
          className="rounded-lg bg-cafe-accent px-3 py-1 text-xs font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:opacity-40"
        >
          {syncing ? '同步中…' : '同步全部'}
        </button>
      </div>
    </ModalOverlay>
  );
}
