'use client';

import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';

export type WorkspaceRunningObjects = Record<string, { catId: string; mode: string; startedAt?: number }>;

interface WorkspaceNowSurfaceProps {
  activeInvocations?: WorkspaceRunningObjects;
  repository?: { name: string; branch: string };
}

function runningLabel(mode: string): string {
  if (mode.includes('headless')) return '正在后台处理这条 thread';
  if (mode.includes('cron')) return '正在执行定时工作';
  return '正在处理这条 thread';
}

export function WorkspaceNowSurface({ activeInvocations = {}, repository }: WorkspaceNowSurfaceProps) {
  const { getCatById } = useCatData();
  const running = Object.entries(activeInvocations).sort(
    ([leftId, left], [rightId, right]) =>
      (left.startedAt ?? 0) - (right.startedAt ?? 0) || leftId.localeCompare(rightId),
  );

  if (running.length === 0) {
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
          {running.map(([invocationId, invocation]) => (
            <article
              key={invocationId}
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
                  {resolveCatDisplayName(invocation.catId, getCatById)}
                </div>
                <div className="mt-0.5 truncate text-micro text-cafe-secondary">{runningLabel(invocation.mode)}</div>
              </div>
              <span className="shrink-0 text-micro text-cafe-muted">进行中</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
