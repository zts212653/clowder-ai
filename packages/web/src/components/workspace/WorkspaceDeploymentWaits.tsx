'use client';

import type { DeploymentWaitListResponse } from '@cat-cafe/shared';
import { WorkspaceDeploymentWaitItem } from './WorkspaceDeploymentWaitItem';

export type DeploymentWaitHydration = 'idle' | 'loading' | 'ready' | 'error';

function shortRevision(revision: string): string {
  return revision.slice(0, 8);
}

function observationAge(observedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - observedAt) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function CandidatePreview({ projection, now }: { projection: DeploymentWaitListResponse; now: number }) {
  const candidate = projection.candidate;
  if (!candidate) return null;
  return (
    <div
      className="rounded-lg border border-cafe-subtle bg-cafe-surface px-3 py-2 text-right"
      data-testid="deployment-candidate-preview"
    >
      <div className="font-mono text-micro font-semibold text-cafe-secondary">
        候选 {shortRevision(candidate.revision)}
      </div>
      <div className="mt-0.5 text-micro text-cafe-muted">观察于 {observationAge(candidate.observedAt, now)}</div>
      <div className="mt-0.5 text-micro text-cafe-muted">预计满足 {candidate.satisfiableCount} 项</div>
      {candidate.unknownCount > 0 && (
        <div className="mt-0.5 text-micro text-conn-amber-text">另有 {candidate.unknownCount} 项证据待确认</div>
      )}
    </div>
  );
}

export function WorkspaceDeploymentWaits({
  projection,
  hydration,
  onRetry,
  now = Date.now(),
}: {
  projection: DeploymentWaitListResponse | null;
  hydration: DeploymentWaitHydration;
  onRetry: () => void;
  now?: number;
}) {
  if (hydration === 'idle') return null;
  if (!projection && hydration === 'loading') {
    return (
      <section
        className="border-b border-cafe-subtle/55 px-5 py-4 text-xs text-cafe-muted"
        data-testid="workspace-deployment-waits"
      >
        正在读取等待更新的事项…
      </section>
    );
  }
  if (!projection) {
    return (
      <section
        className="border-b border-cafe-subtle/55 px-5 py-4 text-xs text-conn-amber-text"
        data-testid="workspace-deployment-waits"
      >
        <span>当前无法读取等待更新清单。</span>
        <button
          type="button"
          className="ml-2 font-semibold underline underline-offset-2"
          onClick={onRetry}
          data-testid="deployment-waits-retry"
        >
          重试
        </button>
      </section>
    );
  }

  const waiting = projection.items.filter((item) => item.state === 'waiting_for_update');
  const unknown = projection.items.filter((item) => item.state === 'unknown');
  const ready = projection.items.filter((item) => item.state === 'ready_to_return');
  const empty = projection.items.length === 0;

  return (
    <section
      className="border-b border-cafe-subtle/55 px-5 py-5"
      data-testid="workspace-deployment-waits"
      aria-labelledby="workspace-deployment-waits-title"
    >
      <div className="mx-auto max-w-2xl" data-testid="f323-deployment-wait-surface">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-micro font-semibold text-cafe-secondary">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--semantic-warning)]" />
              等待与接回
            </div>
            <h2
              id="workspace-deployment-waits-title"
              className="mt-1.5 text-base font-semibold tracking-tight text-cafe-black"
            >
              {empty ? '暂无待跟进事项' : `${projection.items.length} 项待跟进`}
            </h2>
          </div>
          <CandidatePreview projection={projection} now={now} />
        </div>

        {empty ? (
          <p className="mt-3 text-xs leading-5 text-cafe-secondary">
            猫会在原任务里登记“版本就绪后接我回来”，这里会替你记住来源和下一步。
          </p>
        ) : (
          <div className="mt-4 space-y-5">
            {waiting.length > 0 && (
              <div>
                <h3 className="text-micro font-semibold text-cafe-muted">等待更新 · {waiting.length}</h3>
                <div className="mt-1 divide-y divide-cafe-subtle/60 border-y border-cafe-subtle/60">
                  {waiting.map((item) => (
                    <WorkspaceDeploymentWaitItem key={item.taskId} item={item} now={now} />
                  ))}
                </div>
              </div>
            )}
            {unknown.length > 0 && (
              <div>
                <h3 className="text-micro font-semibold text-cafe-secondary">暂不能判定 · {unknown.length}</h3>
                <div className="mt-1 divide-y divide-cafe-subtle/60 border-y border-cafe-subtle/60">
                  {unknown.map((item) => (
                    <WorkspaceDeploymentWaitItem key={item.taskId} item={item} now={now} />
                  ))}
                </div>
              </div>
            )}
            {ready.length > 0 && (
              <div>
                <h3 className="text-micro font-semibold text-conn-green-text">可以接回 · {ready.length}</h3>
                <div className="mt-1 divide-y divide-cafe-subtle/60 border-y border-cafe-subtle/60">
                  {ready.map((item) => (
                    <WorkspaceDeploymentWaitItem key={item.taskId} item={item} now={now} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {hydration === 'error' && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-micro text-conn-amber-text">
            <span>同步暂时失败，以上为最近一次已验证清单。</span>
            <button
              type="button"
              className="font-semibold underline underline-offset-2"
              onClick={onRetry}
              data-testid="deployment-waits-retry"
            >
              重试
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
