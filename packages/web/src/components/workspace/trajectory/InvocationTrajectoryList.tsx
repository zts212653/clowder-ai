import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { InvocationTrajectoryListV2 } from './InvocationTrajectoryListV2';
import {
  copyInvocationRef,
  formatTrajectoryDuration,
  TRAJECTORY_STATUS_CLASS,
  TRAJECTORY_STATUS_LABEL,
} from './invocation-trajectory-ui';
import { trajectoryCopy } from './trajectory.shell-copy';
import { useTrajectoryCopy } from './use-trajectory-copy';

export function InvocationTrajectoryList({
  invocations,
  loading,
  error,
  onOpen,
  onRetry,
  targetInvocationId,
}: {
  invocations: InvocationTrajectorySummary[];
  loading: boolean;
  error: string | null;
  onOpen: (summary: InvocationTrajectorySummary) => void;
  onRetry: () => void;
  targetInvocationId?: string;
}) {
  const isV2 = useShellPresentation() === 'v2';
  const t = useTrajectoryCopy(trajectoryCopy);
  if (loading)
    return <div className="p-6 text-sm text-cafe-muted">{isV2 ? t.loading : '正在召回 invocation 轨迹…'}</div>;
  if (error) {
    return (
      <div className="m-4 rounded-lg bg-conn-red-bg p-3 text-sm text-conn-red-text">
        <p>{error}</p>
        {targetInvocationId && (
          <button
            type="button"
            onClick={() => copyInvocationRef(targetInvocationId)}
            className="mt-2 block font-mono text-xs underline"
          >
            {t.copyRef(targetInvocationId)}
          </button>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-lg border border-conn-red-ring px-2 py-1 text-xs font-semibold"
        >
          {t.retry}
        </button>
      </div>
    );
  }
  if (invocations.length === 0) {
    return (
      <div className="m-4 rounded-xl border border-dashed border-cafe-subtle p-8 text-center">
        <p className="text-sm font-semibold text-cafe">{isV2 ? t.empty : '这段对话还没有 invocation 轨迹'}</p>
        <p className="mt-1 text-xs text-cafe-secondary">{t.emptyHint}</p>
      </div>
    );
  }
  if (isV2) return <InvocationTrajectoryListV2 invocations={invocations} onOpen={onOpen} />;
  return (
    <div className="space-y-2 p-3" data-testid="invocation-trajectory-list">
      {invocations.map((summary) => (
        <button
          type="button"
          key={`${summary.sessionId}:${summary.invocationId}`}
          onClick={() => onOpen(summary)}
          className="console-list-card flex w-full items-start gap-3 rounded-xl p-3 text-left transition-colors hover:border-cafe-accent/35 hover:bg-cafe-surface"
          data-invocation-id={summary.invocationId}
        >
          <span
            className={`mt-0.5 rounded-full px-2 py-0.5 text-micro font-semibold ${TRAJECTORY_STATUS_CLASS[summary.status]}`}
          >
            {TRAJECTORY_STATUS_LABEL[summary.status]}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs font-semibold text-cafe">{summary.catId}</span>
              <span className="text-micro text-cafe-muted">Session #{summary.sessionSeq + 1}</span>
              <span className="text-micro text-cafe-muted">{formatTrajectoryDuration(summary.durationMs)}</span>
            </span>
            <span className="mt-1 block truncate font-mono text-micro text-cafe-secondary">{summary.invocationId}</span>
            <span className="mt-1 block text-xs text-cafe-secondary">
              {summary.toolUseCount} tools · {summary.messageCount} messages · {summary.statusEventCount} status
            </span>
            {summary.keyMessages[0] && (
              <span className="mt-1 block truncate text-xs text-cafe-muted">{summary.keyMessages[0]}</span>
            )}
          </span>
          <span aria-hidden="true" className="mt-2 text-cafe-muted">
            ›
          </span>
        </button>
      ))}
    </div>
  );
}
