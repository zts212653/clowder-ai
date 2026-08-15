'use client';

import { useMemo } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { ExecutionCancelButton } from '../ExecutionCancelButton';

interface WorkspaceNowSurfaceProps {
  repository?: { name: string; branch: string };
}

function runningLabel(kind: 'live_invocation' | 'managed_command'): string {
  return kind === 'managed_command' ? '托管命令' : '实时回合';
}

export function WorkspaceNowSurface({ repository }: WorkspaceNowSurfaceProps) {
  const { getCatById } = useCatData();
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const hydration = useActiveExecutionStore((state) => state.hydration);
  const running = useMemo(
    () =>
      Object.values(executionsByKey).sort(
        (left, right) => left.startedAt - right.startedAt || left.executionId.localeCompare(right.executionId),
      ),
    [executionsByKey],
  );

  if (running.length === 0) {
    if (hydration === 'loading') {
      return (
        <section className="border-b border-cafe-subtle/55 px-5 py-4 text-xs text-cafe-muted">
          正在同步项目里的运行状态…
        </section>
      );
    }
    if (hydration === 'error') {
      return (
        <section className="border-b border-cafe-subtle/55 px-5 py-4 text-xs text-conn-amber-text">
          当前无法验证项目里的运行状态，请稍后重试。
        </section>
      );
    }
    return null;
  }

  return (
    <section className="border-b border-cafe-subtle/55 px-5 py-5" data-testid="workspace-developing">
      <div className="mx-auto max-w-2xl">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-micro font-semibold text-cafe-secondary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--semantic-success)]" />
              正在发生
            </div>
            <h2 className="mt-1.5 text-base font-semibold tracking-tight text-cafe-black">
              {running.length === 1 ? '一件工作正在进行' : `${running.length} 件工作正在进行`}
            </h2>
          </div>
          {repository && (
            <div className="min-w-0 text-right text-micro text-cafe-muted">
              <div className="truncate font-medium text-cafe-secondary">{repository.name}</div>
              <div className="max-w-48 truncate font-mono">{repository.branch}</div>
            </div>
          )}
        </div>

        <div className="divide-y divide-cafe-subtle/60 border-y border-cafe-subtle/60">
          {running.map((execution) => (
            <article
              key={`${execution.kind}:${execution.executionId}`}
              className="group flex items-center gap-3 py-3.5"
              data-testid="workspace-running-object"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cafe-accent/10 text-cafe-accent">
                <svg
                  aria-hidden="true"
                  className="h-3.5 w-3.5"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m5.5 3 6 5-6 5V3Z" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-cafe-black">
                  {resolveCatDisplayName(execution.catId, getCatById)}
                </div>
                <div className="mt-0.5 truncate text-micro text-cafe-secondary">
                  {execution.threadTitle ?? execution.threadId} · {runningLabel(execution.kind)}
                </div>
              </div>
              <ExecutionCancelButton execution={execution} label="停止" />
            </article>
          ))}
        </div>
        {hydration === 'error' && (
          <p className="mt-2 text-micro text-conn-amber-text">同步暂时失败，以上为最近一次已验证状态。</p>
        )}
      </div>
    </section>
  );
}
