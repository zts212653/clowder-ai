import type { InvocationPromptInputProjection, InvocationTrajectorySummary } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { InvocationEvidenceLinks } from './InvocationEvidenceLinks';
import {
  buildInvocationTimelineRows,
  type InvocationTimelineRow,
  type RawTranscriptEvent,
  reconcileInvocationSummary,
} from './invocation-trajectory-model';
import {
  copyInvocationRef,
  formatTrajectoryDuration,
  TRAJECTORY_STATUS_CLASS,
  TRAJECTORY_STATUS_LABEL,
} from './invocation-trajectory-ui';
import { PromptInputCard } from './trajectory-prompt-input-card';
import { SemanticTimelineRow } from './trajectory-semantic-cards';

export interface InvocationDetailResponse {
  invocationId: string;
  events: RawTranscriptEvent[];
  total: number;
  summary?: InvocationTrajectorySummary;
  promptInput?: InvocationPromptInputProjection;
}

function formatTokens(summary: InvocationTrajectorySummary): string | undefined {
  const input = summary.tokens?.input;
  const output = summary.tokens?.output;
  if (input == null && output == null) return undefined;
  return `${input ?? '—'} in · ${output ?? '—'} out`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-cafe-surface px-2.5 py-2">
      <div className="text-micro text-cafe-muted">{label}</div>
      <div className="mt-0.5 truncate font-medium text-cafe-secondary">{value}</div>
    </div>
  );
}

function DetailBody({
  loading,
  error,
  summary,
  detail,
  view,
  rawLimit,
  rows,
  hiddenRowCount,
  totalEffectiveRows,
  expanded,
  onRetry,
  onMoreRaw,
  onToggleExpanded,
  onOpenPromptMessage,
}: {
  loading: boolean;
  error: boolean;
  summary: InvocationTrajectorySummary;
  detail: InvocationDetailResponse | null;
  view: 'timeline' | 'raw';
  rawLimit: number;
  rows: InvocationTimelineRow[];
  hiddenRowCount: number;
  totalEffectiveRows: number;
  expanded: boolean;
  onRetry: () => void;
  onMoreRaw: () => void;
  onToggleExpanded: () => void;
  onOpenPromptMessage: (messageId: string) => void;
}) {
  if (loading) return <div className="text-sm text-cafe-muted">读取 canonical transcript…</div>;
  if (error) {
    return (
      <div className="rounded-lg bg-conn-red-bg p-3 text-sm text-conn-red-text">
        <p>这轮轨迹暂时读取失败。</p>
        <button
          type="button"
          onClick={() => copyInvocationRef(summary.invocationId)}
          className="mt-2 block font-mono text-xs underline"
        >
          复制 inv:{summary.invocationId}
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-lg border border-conn-red-ring px-2 py-1 text-xs font-semibold"
        >
          重试
        </button>
      </div>
    );
  }
  if (view === 'raw') {
    return (
      <div className="space-y-1">
        {(detail?.events ?? []).slice(0, rawLimit).map((event) => (
          <pre
            key={event.eventNo}
            data-raw-event-no={event.eventNo}
            className="overflow-auto rounded-lg bg-cafe-surface p-2 text-micro text-cafe-secondary"
          >
            #{event.eventNo} · {JSON.stringify(event.event, null, 2)}
          </pre>
        ))}
        {(detail?.events.length ?? 0) > rawLimit && (
          <button
            type="button"
            onClick={onMoreRaw}
            className="w-full rounded-lg border border-cafe px-3 py-2 text-xs text-cafe-secondary"
          >
            再显示 100 条
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <PromptInputCard promptInput={detail?.promptInput} onOpenMessage={onOpenPromptMessage} />
      {rows.map((row) => (
        <SemanticTimelineRow key={row.id} row={row} />
      ))}
      {hiddenRowCount > 0 && (
        <button
          type="button"
          onClick={onToggleExpanded}
          className="w-full rounded-lg border border-cafe px-3 py-2 text-xs font-semibold text-cafe-secondary"
        >
          {expanded ? '收起降噪视图' : `展开全部 ${totalEffectiveRows} 行`}
        </button>
      )}
    </div>
  );
}

export function InvocationTrajectoryDetail({
  summary,
  detail,
  loading,
  error,
  onBack,
  onRetry,
  onOpenPromptMessage,
}: {
  summary: InvocationTrajectorySummary;
  detail: InvocationDetailResponse | null;
  loading: boolean;
  error: boolean;
  onBack: () => void;
  onRetry: () => void;
  onOpenPromptMessage: (messageId: string) => void;
}) {
  const [view, setView] = useState<'timeline' | 'raw'>('timeline');
  const [expanded, setExpanded] = useState(false);
  const [rawLimit, setRawLimit] = useState(100);
  const projection = useMemo(() => buildInvocationTimelineRows(detail?.events ?? []), [detail]);
  const displayedSummary = useMemo(() => reconcileInvocationSummary(summary, detail?.summary), [detail, summary]);
  const rows = expanded ? projection.allRows : projection.visibleRows;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="invocation-trajectory-detail">
      <header className="border-b border-cafe-subtle px-3 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg px-2 py-1 text-xs font-semibold text-cafe-secondary hover:bg-cafe-surface"
          >
            ← 返回
          </button>
          <span
            className={`rounded-full px-2 py-0.5 text-micro font-semibold ${TRAJECTORY_STATUS_CLASS[displayedSummary.status]}`}
          >
            {TRAJECTORY_STATUS_LABEL[displayedSummary.status]}
          </span>
          <span className="min-w-0 truncate font-mono text-xs text-cafe-secondary">
            {displayedSummary.invocationId}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Metric label="猫 / Session" value={`${displayedSummary.catId} · #${displayedSummary.sessionSeq + 1}`} />
          <Metric label="耗时" value={formatTrajectoryDuration(displayedSummary.durationMs)} />
          <Metric label="工具 / 消息" value={`${displayedSummary.toolUseCount} / ${displayedSummary.messageCount}`} />
          <Metric label="Tokens" value={formatTokens(displayedSummary) ?? '未报告'} />
        </div>
        {(displayedSummary.sealReason || displayedSummary.terminalReason) && (
          <p className="mt-2 text-micro text-cafe-muted">
            {displayedSummary.sealReason ? `seal: ${displayedSummary.sealReason}` : ''}
            {displayedSummary.sealReason && displayedSummary.terminalReason ? ' · ' : ''}
            {displayedSummary.terminalReason ?? ''}
          </p>
        )}
        <InvocationEvidenceLinks invocationId={displayedSummary.invocationId} />
      </header>
      <div className="flex border-b border-cafe-subtle px-3">
        {(['timeline', 'raw'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setView(mode)}
            className={`px-3 py-2 text-xs font-semibold ${view === mode ? 'border-b-2 border-cafe-accent text-cafe-accent' : 'text-cafe-muted'}`}
          >
            {mode === 'timeline' ? '轨迹' : 'Raw'}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <DetailBody
          loading={loading}
          error={error}
          summary={displayedSummary}
          detail={detail}
          view={view}
          rawLimit={rawLimit}
          rows={rows}
          hiddenRowCount={projection.hiddenRowCount}
          totalEffectiveRows={projection.totalEffectiveRows}
          expanded={expanded}
          onRetry={onRetry}
          onMoreRaw={() => setRawLimit((value) => value + 100)}
          onToggleExpanded={() => setExpanded((value) => !value)}
          onOpenPromptMessage={onOpenPromptMessage}
        />
      </div>
    </div>
  );
}
