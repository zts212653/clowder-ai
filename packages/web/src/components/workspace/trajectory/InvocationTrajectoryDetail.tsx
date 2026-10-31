import type {
  InvocationPromptInputProjection,
  InvocationTrajectorySummary,
  RequestGenerationGapV1,
  RequestGenerationProjectionV1,
} from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { FirstOutputSource } from './FirstOutputSource';
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
import { RequestGenerationSection } from './request-generation-card';
import { TrajectoryCatIdentity } from './TrajectoryCatIdentity';
import { TrajectoryId } from './TrajectoryId';
import { trajectoryCopy } from './trajectory.shell-copy';
import { PromptInputCard } from './trajectory-prompt-input-card';
import { SemanticTimelineRow } from './trajectory-semantic-cards';
import { useTrajectoryCopy } from './use-trajectory-copy';

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

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  const isV2 = useShellPresentation() === 'v2';
  return (
    <div className="rounded-lg bg-cafe-surface px-2.5 py-2">
      <div className="text-micro text-cafe-muted">{label}</div>
      <div
        className={
          isV2
            ? 'mt-0.5 min-w-0 break-words font-medium text-cafe-secondary'
            : 'mt-0.5 truncate font-medium text-cafe-secondary'
        }
      >
        {value}
      </div>
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
  requestGenerations,
  requestGenerationGaps,
  generationsLoading,
  generationsError,
  revealingGenerations,
  onRevealGenerations,
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
  requestGenerations: readonly RequestGenerationProjectionV1[] | null;
  requestGenerationGaps: readonly RequestGenerationGapV1[];
  generationsLoading: boolean;
  generationsError: boolean;
  revealingGenerations: boolean;
  onRevealGenerations: () => void;
}) {
  const isV2 = useShellPresentation() === 'v2';
  const t = useTrajectoryCopy(trajectoryCopy);
  if (loading)
    return <div className="text-sm text-cafe-muted">{isV2 ? t.rawLoading : '读取 canonical transcript…'}</div>;
  if (error) {
    return (
      <div className="rounded-lg bg-conn-red-bg p-3 text-sm text-conn-red-text">
        <p>{t.detailFailed}</p>
        <button
          type="button"
          onClick={() => copyInvocationRef(summary.invocationId)}
          className="mt-2 block font-mono text-xs underline"
        >
          {t.copyRef(summary.invocationId)}
        </button>
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
            {t.moreRaw}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <PromptInputCard promptInput={detail?.promptInput} onOpenMessage={onOpenPromptMessage} />
      {!isV2 && (
        <RequestGenerationSection
          generations={requestGenerations}
          gaps={requestGenerationGaps}
          loading={generationsLoading}
          error={generationsError}
          revealing={revealingGenerations}
          onReveal={onRevealGenerations}
        />
      )}
      {rows.map((row) => (
        <SemanticTimelineRow key={row.id} row={row} catId={isV2 ? summary.catId : undefined} />
      ))}
      {hiddenRowCount > 0 && (
        <button
          type="button"
          onClick={onToggleExpanded}
          className="w-full rounded-lg border border-cafe px-3 py-2 text-xs font-semibold text-cafe-secondary"
        >
          {expanded ? t.collapse : t.expandRows(totalEffectiveRows)}
        </button>
      )}
      {isV2 && (
        <>
          <FirstOutputSource summary={summary} />
          <RequestGenerationSection
            generations={requestGenerations}
            gaps={requestGenerationGaps}
            loading={generationsLoading}
            error={generationsError}
            revealing={revealingGenerations}
            onReveal={onRevealGenerations}
          />
        </>
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
  requestGenerations = null,
  requestGenerationGaps = [],
  generationsLoading = false,
  generationsError = false,
  revealingGenerations = false,
  onRevealGenerations = () => {},
}: {
  summary: InvocationTrajectorySummary;
  detail: InvocationDetailResponse | null;
  loading: boolean;
  error: boolean;
  onBack: () => void;
  onRetry: () => void;
  onOpenPromptMessage: (messageId: string) => void;
  requestGenerations?: readonly RequestGenerationProjectionV1[] | null;
  requestGenerationGaps?: readonly RequestGenerationGapV1[];
  generationsLoading?: boolean;
  generationsError?: boolean;
  revealingGenerations?: boolean;
  onRevealGenerations?: () => void;
}) {
  const isV2 = useShellPresentation() === 'v2';
  const t = useTrajectoryCopy(trajectoryCopy);
  const [view, setView] = useState<'timeline' | 'raw'>('timeline');
  const [expanded, setExpanded] = useState(false);
  const [rawLimit, setRawLimit] = useState(100);
  const projection = useMemo(
    () => buildInvocationTimelineRows(detail?.events ?? [], undefined, { nativeMessages: isV2 }),
    [detail, isV2],
  );
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
            {isV2 ? t.back : '← 返回'}
          </button>
          <span
            className={`rounded-full px-2 py-0.5 text-micro font-semibold ${TRAJECTORY_STATUS_CLASS[displayedSummary.status]}`}
          >
            {isV2 ? t[displayedSummary.status] : TRAJECTORY_STATUS_LABEL[displayedSummary.status]}
          </span>
          {isV2 ? (
            <div className="min-w-0 flex-1">
              <TrajectoryId kind="调用" value={displayedSummary.invocationId} />
            </div>
          ) : (
            <span className="min-w-0 truncate font-mono text-xs text-cafe-secondary">
              {displayedSummary.invocationId}
            </span>
          )}
        </div>
        <div
          className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"
          style={isV2 ? { gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 130px), 1fr))' } : undefined}
        >
          <Metric
            label={isV2 ? t.catSession : '猫 / Session'}
            value={
              isV2 ? (
                <>
                  <TrajectoryCatIdentity catId={displayedSummary.catId} />
                  <span className="block text-micro">{t.segment(displayedSummary.sessionSeq + 1)}</span>
                  <TrajectoryId kind="会话" value={displayedSummary.sessionId} />
                </>
              ) : (
                `${displayedSummary.catId} · #${displayedSummary.sessionSeq + 1}`
              )
            }
          />
          <Metric label={t.duration} value={formatTrajectoryDuration(displayedSummary.durationMs)} />
          <Metric
            label={t.toolsMessages}
            value={`${displayedSummary.toolUseCount} / ${displayedSummary.messageCount}`}
          />
          <Metric
            label={isV2 ? 'Token' : 'Tokens'}
            value={
              isV2 && displayedSummary.tokens
                ? t.tokens(displayedSummary.tokens.input ?? '—', displayedSummary.tokens.output ?? '—')
                : (formatTokens(displayedSummary) ?? t.unreported)
            }
          />
        </div>
        {(displayedSummary.sealReason || displayedSummary.terminalReason) && (
          <p className="mt-2 text-micro text-cafe-muted">
            {displayedSummary.sealReason ? `${isV2 ? t.sealed : 'seal'}: ${displayedSummary.sealReason}` : ''}
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
            {mode === 'timeline' ? t.timeline : isV2 ? t.raw : 'Raw'}
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
          requestGenerations={requestGenerations}
          requestGenerationGaps={requestGenerationGaps}
          generationsLoading={generationsLoading}
          generationsError={generationsError}
          revealingGenerations={revealingGenerations}
          onRevealGenerations={onRevealGenerations}
        />
      </div>
    </div>
  );
}
