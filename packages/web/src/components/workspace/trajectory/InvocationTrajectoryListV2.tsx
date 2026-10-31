import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { formatTrajectoryDuration, TRAJECTORY_STATUS_CLASS } from './invocation-trajectory-ui';
import { TrajectoryCatIdentity } from './TrajectoryCatIdentity';
import { TrajectoryId } from './TrajectoryId';
import { trajectoryCopy } from './trajectory.shell-copy';
import { type FirstAssistantPreview, firstAssistantPreview } from './trajectory-first-output';
import { useTrajectoryCopy } from './use-trajectory-copy';

function FirstOutputPreview({ preview }: { preview: FirstAssistantPreview }) {
  const t = useTrajectoryCopy(trajectoryCopy);
  return (
    <span
      className="mt-1 block whitespace-pre-wrap break-words text-xs text-cafe-muted"
      data-testid="first-assistant-preview"
      data-preview-kind={preview.kind}
    >
      {preview.kind !== 'sentence' && (
        <span className="block" data-testid="first-assistant-preview-label">
          {previewLabel(preview.label, t)}
        </span>
      )}
      {preview.kind !== 'unavailable' && (
        <span className="block" data-testid="first-assistant-preview-content">
          {preview.content}
        </span>
      )}
    </span>
  );
}

export function InvocationTrajectoryListV2({
  invocations,
  onOpen,
}: {
  invocations: InvocationTrajectorySummary[];
  onOpen: (summary: InvocationTrajectorySummary) => void;
}) {
  const t = useTrajectoryCopy(trajectoryCopy);
  return (
    <div className="space-y-2 p-3" data-testid="invocation-trajectory-list">
      {invocations.map((summary) => (
        <article
          key={`${summary.sessionId}:${summary.invocationId}`}
          data-invocation-id={summary.invocationId}
          className="console-list-card min-w-0 rounded-xl p-3"
        >
          <button
            type="button"
            onClick={() => onOpen(summary)}
            className="flex w-full min-w-0 items-start gap-3 rounded-lg text-left hover:bg-cafe-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cafe-accent"
          >
            <span
              className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-micro font-semibold ${TRAJECTORY_STATUS_CLASS[summary.status]}`}
            >
              {t[summary.status]}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <TrajectoryCatIdentity catId={summary.catId} />
                <span className="text-micro text-cafe-muted">{t.segment(summary.sessionSeq + 1)}</span>
                <span className="text-micro text-cafe-muted">{formatTrajectoryDuration(summary.durationMs)}</span>
              </span>
              <span className="mt-1 block text-xs text-cafe-secondary">
                {t.counts(summary.toolUseCount, summary.messageCount, summary.statusEventCount)}
              </span>
              <FirstOutputPreview preview={firstAssistantPreview(summary)} />
            </span>
            <span aria-hidden="true" className="text-cafe-muted">
              ›
            </span>
          </button>
          <div className="mt-1 min-w-0">
            <TrajectoryId kind="调用" value={summary.invocationId} />
            <TrajectoryId kind="会话" value={summary.sessionId} />
          </div>
        </article>
      ))}
    </div>
  );
}

function previewLabel(label: string, t: typeof trajectoryCopy.zh): string {
  const labels: Record<string, string> = {
    首句边界未确认: t.boundaryUnconfirmed,
    尚无可核验的首条输出: t.noFirstOutput,
    首条输出归属无法核验: t.wrongOwner,
    首条输出身份无法核验: t.unknownIdentity,
    首条输出通道无法核验: t.unknownChannel,
    首条输出尚未完整: t.incomplete,
    首条输出记录有冲突: t.conflict,
    '首条输出超出预览上限，请查看原始记录': t.oversized,
    首条输出证据不完整: t.incompleteEvidence,
    首条输出尚无可展示的候选: t.noCandidate,
  };
  return labels[label] ?? label;
}
