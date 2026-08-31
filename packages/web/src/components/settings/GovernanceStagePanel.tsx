'use client';

/** F257 Phase D — Governance stage detail panel with operation actions. */

import type { ActionableInfo, ActiveStage, SegmentEnablementMatrix } from '@cat-cafe/shared';
import { SettingsBadge, SettingsText } from './primitives';
import { RollbackButton, ToggleOverrideButton } from './VersionActions';

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

export interface GovernanceStagePanelProps {
  version: number;
  governance: { decision: string | null; decidedAt: number | null; actorId: string | null } | null;
  guardEvents: GuardEvent[];
  overrideState: { hookId: string; enabled: boolean } | null;
  hookId: string;
  onRefresh: () => void;
  /** 判据①: whether this epoch is the active version (actionable speaks about it). */
  isActiveEpoch: boolean;
  /** 判据①: real loop stage of the active version. */
  activeStage: ActiveStage;
  /** 判据①: actionable only via real pending Candidates (honest gap when unwired). */
  actionable: ActionableInfo;
  /** F257 Console 判据⑥: unified enablement matrix for CTA states and blocked reasons. */
  enablementMatrix: SegmentEnablementMatrix;
}

const formatTs = (ms: number) => new Date(ms).toLocaleString();

export function GovernanceStagePanel({
  version,
  governance,
  guardEvents,
  overrideState,
  hookId,
  onRefresh,
  isActiveEpoch,
  activeStage,
  actionable,
  enablementMatrix,
}: GovernanceStagePanelProps) {
  /** P1-4: null overrideState = default enabled (manifest baseline, no override record yet). */
  const effectiveEnabled = overrideState?.enabled ?? true;
  // 判据① P1-4: real pending Candidates are the ONLY actionable signal —
  // computed independently of the synthesized epoch.governance.decision.
  const candidateCount =
    isActiveEpoch && actionable.source === 'candidate-count' ? (actionable.candidateCount ?? 0) : 0;

  return (
    <>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        v{version} — Governance
      </SettingsText>

      <div className="mb-3">
        <InfoRow label="当前状态">
          <SettingsBadge tone={effectiveEnabled ? 'emerald' : 'red'} size="xxs">
            {effectiveEnabled ? '已启用' : '已禁用'}
          </SettingsBadge>
          {!overrideState && <span className="ml-2 text-xs text-cafe-muted">（默认）</span>}
        </InfoRow>
      </div>

      {candidateCount > 0 ? (
        <CandidateRow count={candidateCount} />
      ) : (
        <DecisionArea
          governance={governance}
          isActiveEpoch={isActiveEpoch}
          activeStage={activeStage}
          actionable={actionable}
        />
      )}

      <div className="mt-4 flex gap-2">
        <ToggleOverrideButton
          hookId={hookId}
          currentlyEnabled={effectiveEnabled}
          onRefresh={onRefresh}
          enablementMatrix={enablementMatrix}
        />
        <RollbackButton hookId={hookId} onRefresh={onRefresh} enablementMatrix={enablementMatrix} />
      </div>

      <GuardEventsSection guardEvents={guardEvents} />
    </>
  );
}

/** 判据① P1-4: real pending Candidates — the only actionable governance state. */
function CandidateRow({ count }: { count: number }) {
  return (
    <InfoRow label="治理候选">
      <SettingsBadge tone="amber" size="xxs">
        {count} 个候选待审
      </SettingsBadge>
      <span className="ml-2 text-xs text-cafe-muted">需 operator 决策</span>
    </InfoRow>
  );
}

/**
 * Informational decision area (no real Candidates). The synthesized
 * governance.pending is NEVER an operator-action signal (the original
 * incident's false signal); when the Candidate projection is unwired we say
 * so honestly (provenance gap). P2-2: wording is verdict-neutral —
 * dormant ≠ pass, so never 评估已通过.
 */
function DecisionArea({
  governance,
  isActiveEpoch,
  activeStage,
  actionable,
}: {
  governance: GovernanceStagePanelProps['governance'];
  isActiveEpoch: boolean;
  activeStage: ActiveStage;
  actionable: ActionableInfo;
}) {
  if (governance?.decision === 'approved') {
    return (
      <InfoRow label="决策">
        <SettingsBadge tone="emerald" size="xxs">
          approved
        </SettingsBadge>
        {governance.decidedAt && <span className="ml-2 text-xs text-cafe-muted">{formatTs(governance.decidedAt)}</span>}
      </InfoRow>
    );
  }

  if (governance?.decision === 'pending') {
    return (
      <InfoRow label="决策">
        <SettingsBadge tone="slate" size="xxs">
          评估完成
        </SettingsBadge>
        {isActiveEpoch && (
          <span className="ml-2 text-xs text-cafe-muted">
            {actionable.source === 'candidate-count'
              ? '当前无治理候选（无需动作）'
              : '治理候选数据暂不可用（provenance gap），无法判断是否需要 operator 操作'}
          </span>
        )}
      </InfoRow>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2 py-6 opacity-40">
      <span className="text-2xl">{'🛡️'}</span>
      <SettingsText as="p" variant="xs" tone="muted">
        未进入治理环节
      </SettingsText>
      {isActiveEpoch && activeStage === 'tracing' && (
        <SettingsText as="p" variant="xs" tone="muted">
          当前循环位于 tracing，暂无治理事项
        </SettingsText>
      )}
    </div>
  );
}

function GuardEventsSection({ guardEvents }: { guardEvents: GuardEvent[] }) {
  if (guardEvents.length === 0) return null;
  return (
    <div className="mt-4">
      <SettingsText as="h4" variant="xs" tone="muted" className="mb-2 font-semibold">
        守卫事件 ({guardEvents.length})
      </SettingsText>
      {guardEvents[0]?.attribution === 'window-correlated' && (
        <SettingsText as="p" variant="xs" tone="muted" className="mb-2 italic">
          时间窗口关联，非因果归因
        </SettingsText>
      )}
      <div className="max-h-[160px] space-y-1 overflow-y-auto">
        {guardEvents.map((ev) => (
          <Row key={ev.eventId} ts={ev.timestamp}>
            <SettingsBadge tone="red" size="xxs">
              {ev.kind}
            </SettingsBadge>
            <span className="text-cafe-secondary">@{ev.catId}</span>
            <span className="ml-auto font-mono text-cafe-muted">{ev.guardId}</span>
          </Row>
        ))}
      </div>
    </div>
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
