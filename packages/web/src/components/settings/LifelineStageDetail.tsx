'use client';

/** F257 Phase D — Stage detail panel for lifeline (version/tracing/eval/governance). */

import type { ActionableInfo, ActiveStage, GuardMetric, SegmentEnablementMatrix } from '@cat-cafe/shared';
import { useState } from 'react';
import { CreateVersionForm } from './CreateVersionForm';
import { EvalStagePanel } from './EvalStagePanel';
import { GovernanceStagePanel } from './GovernanceStagePanel';
import type { SelectedStage } from './LifelineChainView';
import { SettingsBadge, SettingsText } from './primitives';
import { SegmentReplayPanel } from './SegmentReplayPanel';
import { ActivateVersionButton, RollbackButton } from './VersionActions';

interface VersionEpoch {
  version: number;
  origin: string;
  startedAt: number;
  status: string;
  isActive: boolean;
  tracing: {
    observationCount: number;
    /** 判据② P1 (sol R5): producer-semantics fired count (observe-only rows excluded). */
    firedCount: number;
    firstAt: number | null;
    lastAt: number | null;
  } | null;
  eval: {
    verdict: string | null;
    injectionCount: number;
    violationCount: number;
    evaluatedAt: number | null;
    /** 判据②: the judgment's OWN eval sampling window. null/undefined = legacy (fail-visible). */
    evalWindow?: { startMs: number; endMs: number } | null;
    /** 判据②: denominator semantics of the counts. null/undefined = legacy (fail-visible). */
    denominatorKind?: string | null;
  } | null;
  governance: { decision: string | null; decidedAt: number | null; actorId: string | null } | null;
  events: Array<{ eventId: string; kind: string; timestamp: number; actorId: string; detail: string }>;
}

interface Observation {
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
  version: number | null;
  charCount: number;
}

interface GuardEvent {
  eventId: string;
  kind: string;
  threadId: string;
  catId: string;
  timestamp: number;
  guardId: string;
  /** Attribution hint: guard events are window-correlated, not causally linked. */
  attribution?: 'window-correlated';
}

interface LifelineStageDetailProps {
  selected: SelectedStage;
  chain: VersionEpoch[];
  observations: Observation[];
  /**
   * P1 (sol R6): true when the DETAIL list was truncated at the route's
   * 100-row cap. Aggregate epoch counts stay exact (full-window scan) — this
   * flag only labels the detail list, never the counts.
   */
  observationsCapped?: boolean;
  guardEvents: GuardEvent[];
  /** Per-epoch guard metrics from API (activation-timeline attributed, R15). */
  epochGuardMetrics: Record<number, GuardMetric[]>;
  overrideState: { hookId: string; enabled: boolean } | null;
  /** Hook ID for version operations (same as segmentId). */
  hookId: string;
  /** Refresh lifeline data after a mutation. */
  onRefresh: () => void;
  /** 判据①: real loop stage of the active version. */
  activeStage: ActiveStage;
  /** 判据①: actionable only via real pending Candidates (honest gap when unwired). */
  actionable: ActionableInfo;
  /** 判据②: the CURRENT lifeline query window — labeled on the tracing panel as such. */
  queryWindow?: { startMs: number; endMs: number } | null;
  /** F257 Console 判据⑥: unified enablement matrix for CTA states and blocked reasons. */
  enablementMatrix: SegmentEnablementMatrix;
}

const formatTs = (ms: number) => new Date(ms).toLocaleString();
const formatRel = (ms: number) => {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 60 ? `${m}分钟前` : m < 1440 ? `${Math.floor(m / 60)}小时前` : `${Math.floor(m / 1440)}天前`;
};

export function LifelineStageDetail({
  selected,
  chain,
  observations,
  observationsCapped,
  guardEvents,
  epochGuardMetrics,
  overrideState,
  hookId,
  onRefresh,
  activeStage,
  actionable,
  queryWindow,
  enablementMatrix,
}: LifelineStageDetailProps) {
  const epoch = chain.find((e) => e.version === selected.version);
  if (!epoch) return null;

  return (
    <div className="rounded-2xl p-4" style={{ backgroundColor: 'var(--console-panel-bg)' }}>
      {selected.stage === 'version' && (
        <VersionDetail epoch={epoch} hookId={hookId} onRefresh={onRefresh} enablementMatrix={enablementMatrix} />
      )}
      {selected.stage === 'tracing' && (
        <TracingDetail
          epoch={epoch}
          hookId={hookId}
          observations={observations}
          observationsCapped={observationsCapped}
          queryWindow={queryWindow}
        />
      )}
      {selected.stage === 'eval' && (
        <EvalStagePanel
          version={epoch.version}
          eval={epoch.eval}
          tracing={epoch.tracing}
          guardMetrics={epochGuardMetrics[epoch.version] ?? []}
          queryWindow={queryWindow}
        />
      )}
      {selected.stage === 'governance' && (
        <GovernanceStagePanel
          version={epoch.version}
          governance={epoch.governance}
          guardEvents={guardEvents}
          overrideState={overrideState}
          hookId={hookId}
          onRefresh={onRefresh}
          isActiveEpoch={epoch.isActive}
          activeStage={activeStage}
          actionable={actionable}
          enablementMatrix={enablementMatrix}
        />
      )}
    </div>
  );
}

function VersionDetail({
  epoch,
  hookId,
  onRefresh,
  enablementMatrix,
}: {
  epoch: VersionEpoch;
  hookId: string;
  onRefresh: () => void;
  enablementMatrix: SegmentEnablementMatrix;
}) {
  const originLabel =
    { manifest: '基线', 'auto-iterate': '自动迭代', 'user-create': '用户创建' }[epoch.origin] ?? epoch.origin;

  return (
    <>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        v{epoch.version} — {originLabel}
      </SettingsText>

      <div className="space-y-2">
        <InfoRow label="状态">
          <StatusBadge status={epoch.status} />
        </InfoRow>
        {epoch.startedAt > 0 && <InfoRow label="创建时间">{formatTs(epoch.startedAt)}</InfoRow>}
        <InfoRow label="当前激活">
          <SettingsBadge tone={epoch.isActive ? 'emerald' : 'slate'} size="xxs">
            {epoch.isActive ? '是' : '否'}
          </SettingsBadge>
        </InfoRow>
      </div>

      {epoch.isActive && (
        <div className="mt-3">
          <CreateVersionForm hookId={hookId} onRefresh={onRefresh} />
        </div>
      )}
      {!epoch.isActive && epoch.version > 1 && (
        <div className="mt-3">
          <ActivateVersionButton
            hookId={hookId}
            epochVersion={epoch.version}
            onRefresh={onRefresh}
            enablementMatrix={enablementMatrix}
          />
        </div>
      )}
      {!epoch.isActive && epoch.version === 1 && (
        <div className="mt-3">
          <RollbackButton hookId={hookId} onRefresh={onRefresh} enablementMatrix={enablementMatrix} />
        </div>
      )}

      {epoch.events.length > 0 && (
        <div className="mt-4">
          <SettingsText as="h4" variant="xs" tone="muted" className="mb-2 font-semibold">
            事件 ({epoch.events.length})
          </SettingsText>
          <div className="space-y-1">
            {epoch.events.map((ev) => (
              <EventRow key={ev.eventId} event={ev} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function TracingDetail({
  epoch,
  hookId,
  observations,
  observationsCapped,
  queryWindow,
}: {
  epoch: VersionEpoch;
  hookId: string;
  observations: Observation[];
  observationsCapped?: boolean;
  queryWindow?: { startMs: number; endMs: number } | null;
}) {
  const versionObs = observations.filter((o) => o.version === epoch.version || o.version == null);

  return (
    <>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        v{epoch.version} — Tracing
        {epoch.tracing && (
          <span className="ml-2 text-xs font-normal text-cafe-muted">({epoch.tracing.observationCount} 次观测)</span>
        )}
      </SettingsText>

      {/* P1 (sol R6): the detail list may be truncated at the route's 100-row
          cap — say so explicitly. The counts above stay exact (full-window
          aggregate), so completeness provenance lives here, not on the numbers. */}
      {observationsCapped && (
        <SettingsText as="p" variant="xs" tone="muted" className="mb-2 italic">
          明细仅显示最近 100 条（上方计数为完整窗口精确聚合）
        </SettingsText>
      )}

      {/* 判据②: label the observation counts with the CURRENT query window —
          a distinct coordinate from the eval stage's historical sampling window. */}
      {queryWindow && (
        <div className="mb-3">
          <InfoRow label="观测窗口">
            <span>
              {formatTs(queryWindow.startMs)} ~ {formatTs(queryWindow.endMs)}
              <span className="ml-1 text-cafe-muted">（当前查询窗口，非评估窗口）</span>
            </span>
          </InfoRow>
        </div>
      )}

      {epoch.tracing?.firstAt && epoch.tracing.lastAt && (
        <div className="mb-3 space-y-1">
          <InfoRow label="首次观测">{formatRel(epoch.tracing.firstAt)}</InfoRow>
          <InfoRow label="最近观测">{formatRel(epoch.tracing.lastAt)}</InfoRow>
        </div>
      )}

      {versionObs.length > 0 ? (
        <div className="max-h-[240px] space-y-1 overflow-y-auto">
          {versionObs.slice(0, 50).map((obs) => (
            <ObservationRow key={`${obs.threadId}-${obs.turnId}`} obs={obs} segmentId={hookId} />
          ))}
          {versionObs.length > 50 && (
            <SettingsText as="p" variant="xs" tone="muted" className="pt-1 italic">
              还有 {versionObs.length - 50} 条...
            </SettingsText>
          )}
        </div>
      ) : (
        <SettingsText as="p" variant="xs" tone="muted" className="italic">
          该版本无观测数据
        </SettingsText>
      )}
    </>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-[80px] shrink-0 text-cafe-muted">{label}</span>
      <span className="text-cafe">{children}</span>
    </div>
  );
}

const STATUS_MAP: Record<string, [string, 'emerald' | 'amber' | 'red' | 'slate']> = {
  idle: ['空闲', 'slate'],
  tracing: ['观测中', 'emerald'],
  'eval-pending': ['待评估', 'amber'],
  'eval-pass': ['评估通过', 'emerald'],
  'eval-reject': ['评估未通过', 'red'],
  // 判据①: synthesized governance-pending is informational (评估完成，停在治理环节),
  // NOT an attention signal — actionability comes only from real Candidate count.
  // P2-2: verdict-neutral wording — dormant ≠ pass.
  'governance-pending': ['评估完成·治理环节', 'slate'],
  'governance-approved': ['治理通过', 'emerald'],
};
function StatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS_MAP[status] ?? [status, 'slate' as const];
  return (
    <SettingsBadge tone={tone} size="xxs">
      {label}
    </SettingsBadge>
  );
}

const KIND_LABEL: Record<string, string> = {
  'auto-iterate': '自动迭代',
  'user-create': '用户创建',
  'version-activate': '版本切换',
  'user-edit': '用户编辑',
  'eval-pass': '评估通过',
  'eval-reject': '评估未通过',
  'governance-approve': '治理通过',
  'governance-reject': '治理禁用',
};
function EventRow({
  event,
}: {
  event: { eventId: string; kind: string; timestamp: number; actorId: string; detail: string };
}) {
  return (
    <Row ts={event.timestamp}>
      <SettingsBadge tone="amber" size="xxs">
        {KIND_LABEL[event.kind] ?? event.kind}
      </SettingsBadge>
      <span className="text-cafe-secondary">{event.detail}</span>
      <span className="ml-auto text-cafe-muted">@{event.actorId}</span>
    </Row>
  );
}

function ObservationRow({ obs, segmentId }: { obs: Observation; segmentId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  return (
    <div>
      <button type="button" className="w-full text-left" onClick={() => setExpanded((e) => !e)}>
        <Row ts={obs.timestamp}>
          <SettingsBadge tone={obs.pipelineStatus === 'fired' ? 'emerald' : 'slate'} size="xxs">
            {obs.pipelineStatus}
          </SettingsBadge>
          <span className="text-cafe-secondary">@{obs.catId}</span>
          <span className="ml-auto flex items-center gap-2 text-cafe-muted">
            {obs.charCount} chars {expanded ? '▾' : '▸'}
          </span>
        </Row>
      </button>
      {expanded && (
        <div className="ml-[132px] space-y-0.5 pb-1 text-xs text-cafe-muted">
          <div className="flex items-center gap-2">
            <span>
              Thread: <span className="font-mono">{obs.threadId}</span>
            </span>
            <button
              type="button"
              onClick={() => setReplayOpen(true)}
              className="rounded-full px-2 py-0.5 text-micro font-semibold text-[var(--console-active-fg)] hover:bg-[var(--console-active-bg)]"
            >
              回放现场
            </button>
          </div>
          <div>
            Turn: <span className="font-mono">{obs.turnId}</span>
          </div>
          {obs.version != null && <div>Version: v{obs.version}</div>}
          <SegmentReplayPanel
            segmentId={segmentId}
            threadId={obs.threadId}
            turnId={obs.turnId}
            catId={obs.catId}
            pipelineStatus={obs.pipelineStatus}
            isOpen={replayOpen}
            onClose={() => setReplayOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

function Row({ ts, children }: { ts: number; children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-xs hover:brightness-95"
      style={{ backgroundColor: 'var(--console-elevated-bg)' }}
    >
      <span className="w-[120px] shrink-0 font-mono text-cafe-muted">{formatTs(ts)}</span>
      {children}
    </div>
  );
}
