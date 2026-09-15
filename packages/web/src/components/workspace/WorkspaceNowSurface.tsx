'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { WorkspaceRunningWork } from './WorkspaceRunningWork';
import { groupRunningWork } from './workspace-running-work';

interface WorkspaceNowSurfaceProps {
  repository?: { name: string; branch: string };
  onSelectExecution?: (execution: ActiveExecutionProjection) => void;
}

export function WorkspaceNowSurface({ repository, onSelectExecution }: WorkspaceNowSurfaceProps) {
  const { getCatById } = useCatData();
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const hydration = useActiveExecutionStore((state) => state.hydration);
  const running = useMemo(() => groupRunningWork(Object.values(executionsByKey)), [executionsByKey]);

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
          {running.map((work) => (
            <WorkspaceRunningWork
              key={work.key}
              work={work}
              catName={resolveCatDisplayName(work.catId, getCatById)}
              onSelectExecution={onSelectExecution}
            />
          ))}
        </div>
        {hydration === 'error' && (
          <p className="mt-2 text-micro text-conn-amber-text">同步暂时失败，以上为最近一次已验证状态。</p>
        )}
      </div>
    </section>
  );
}
