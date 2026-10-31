'use client';

import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { rankInvocationSummariesForRecall } from './trajectory/invocation-trajectory-model';
import { openInvocationTrajectory } from './trajectory/trajectory-navigation';

function statusLabel(status: InvocationTrajectorySummary['status']): string {
  if (status === 'done') return '完成';
  if (status === 'running') return '运行中';
  if (status === 'cancelled') return '已取消';
  if (status === 'timeout') return '超时';
  return '出错';
}

interface RecallResultSet {
  threadId: string;
  invocations: InvocationTrajectorySummary[];
}

export function RecentTrajectoryRecall({ threadId }: { threadId: string }) {
  const [recallResult, setRecallResult] = useState<RecallResultSet>(() => ({
    threadId,
    invocations: [],
  }));
  useEffect(() => {
    let cancelled = false;
    void apiFetch(`/api/threads/${threadId}/invocations?limit=50`)
      .then(async (response) => (response.ok ? response.json() : { invocations: [] }))
      .then((body: { invocations?: InvocationTrajectorySummary[] }) => {
        if (!cancelled) {
          setRecallResult({
            threadId,
            invocations: rankInvocationSummariesForRecall(body.invocations ?? []),
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [threadId]);
  const invocations = recallResult.threadId === threadId ? recallResult.invocations : [];
  if (invocations.length === 0) return null;
  return (
    <section data-testid="workspace-launcher-recent-trajectories">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-label font-semibold text-cafe-secondary">最近轨迹</h3>
        <button
          type="button"
          onClick={() => useChatStore.getState().setWorkspaceMode('trajectory')}
          className="text-micro font-semibold text-cafe-accent hover:underline"
        >
          更多轨迹
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {invocations.map((invocation) => (
          <button
            type="button"
            key={invocation.invocationId}
            data-recent-invocation={invocation.invocationId}
            data-trajectory-status={invocation.status}
            onClick={() =>
              openInvocationTrajectory({
                threadId,
                sessionId: invocation.sessionId,
                invocationId: invocation.invocationId,
              })
            }
            className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-3 text-left transition-colors hover:border-cafe-accent/35"
          >
            <span
              className={`text-micro font-semibold ${invocation.status === 'error' || invocation.status === 'timeout' ? 'text-conn-red-text' : invocation.status === 'cancelled' ? 'text-conn-amber-text' : 'text-cafe-secondary'}`}
            >
              {statusLabel(invocation.status)}
            </span>
            <span className="mt-1 block truncate text-xs font-semibold text-cafe">{invocation.catId}</span>
            <span className="mt-0.5 block truncate font-mono text-micro text-cafe-muted">
              {invocation.invocationId}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
