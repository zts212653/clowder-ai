'use client';

import type { SegmentCycleSummary, SegmentEvaluationResponse } from '@cat-cafe/shared';
import { SettingsBadge, SettingsText } from './primitives';

const formatTs = (value: number) => new Date(value).toLocaleString();

export function ObjectiveGovernancePanel({ data }: { data: SegmentEvaluationResponse }) {
  if (data.objectives.length === 0) {
    return <EmptyCard text="该段尚未挂接 Objective，因此没有治理周期。" />;
  }
  return (
    <div className="space-y-4" data-testid="objective-governance-panel">
      {data.objectives.map((objective) => (
        <ObjectiveGovernanceCard key={objective.objectiveId} segmentId={data.segmentId} objective={objective} />
      ))}
    </div>
  );
}

function ObjectiveGovernanceCard({
  segmentId,
  objective,
}: {
  segmentId: string;
  objective: SegmentEvaluationResponse['objectives'][number];
}) {
  return (
    <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
          {objective.objectiveLabel}
        </SettingsText>
        <SettingsBadge tone="slate" size="xxs">
          {objective.objectiveId}
        </SettingsBadge>
      </div>
      <GovernanceOutcome segmentId={segmentId} objective={objective} />
    </section>
  );
}

function GovernanceOutcome({
  segmentId,
  objective,
}: {
  segmentId: string;
  objective: SegmentEvaluationResponse['objectives'][number];
}) {
  const termination = objective.selectedCycle?.termination;
  if (termination) {
    return (
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <MetaRow label="状态">
          <SettingsBadge tone="amber" size="xxs">
            已停止
          </SettingsBadge>
        </MetaRow>
        <MetaRow label="停止时间">{formatTs(termination.at)}</MetaRow>
        <MetaRow label="操作人">@{termination.by}</MetaRow>
        <MetaRow label="版本切换">
          {termination.baseVersion == null
            ? `${termination.segmentId}：v${termination.fromVersion} → v${termination.toVersion}`
            : `当前版本 v${termination.fromVersion} → v${termination.toVersion}（基于 v${termination.baseVersion}）`}
        </MetaRow>
        <MetaRow label="说明">{termination.reason}</MetaRow>
      </div>
    );
  }
  const governance = objective.latestGovernance;
  if (!governance) return <MissingGovernance objective={objective} />;
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <MetaRow label="decision">
        <SettingsBadge tone={decisionTone(governance.decision)} size="xxs">
          {decisionLabel(governance.decision)}
        </SettingsBadge>
      </MetaRow>
      <MetaRow label="治理时间">{formatTs(governance.writtenAt)}</MetaRow>
      <MetaRow label="决策者">@{governance.by}</MetaRow>
      <MetaRow label="理由">{governance.reason}</MetaRow>
      {governance.decision !== 'keep' && (
        <MetaRow label="改动范围">
          {governanceImpactLabel(segmentId, governance.impact, governance.approval?.state ?? null)}
        </MetaRow>
      )}
      <MetaRow label="审批卡">
        {governance.approval ? (
          <>
            <ApprovalBadge state={governance.approval.state} />
            {governance.approval.cardId && <span className="ml-2 font-mono">{governance.approval.cardId}</span>}
          </>
        ) : (
          'keep 无需审批卡'
        )}
      </MetaRow>
      {governance.approval?.reason && <MetaRow label="审批理由">{governance.approval.reason}</MetaRow>}
    </div>
  );
}

function MissingGovernance({ objective }: { objective: SegmentEvaluationResponse['objectives'][number] }) {
  const text =
    objective.selectedCycle?.evalStatus === 'written'
      ? objective.selectedCycle.evaluation?.overall === 'insufficient_evidence'
        ? '证据不足，本周期不进入治理；已并入下一周期继续累计。'
        : '本周期评估已回写，尚未形成 governance 决策。'
      : '本周期尚未进入 governance。';
  return (
    <SettingsText as="p" variant="xs" tone="muted" className="mt-3">
      {text}
    </SettingsText>
  );
}

function governanceImpactLabel(
  segmentId: string,
  impact: SegmentCycleSummary['governanceImpact'],
  approvalState: NonNullable<SegmentCycleSummary['approval']>['state'] | null,
): string {
  if (!impact) return '提案改动范围暂不可用';
  if (approvalState === 'skipped' || approvalState === 'rejected') return '提案未应用，版本未变化';
  const changes = impact.changes.map((change) => governanceChangeLabel(change, approvalState)).join('；');
  const scope = changes || `改动 ${impact.changedUnitIds.join('、')}`;
  return impact.selectedSegmentChanged ? scope : `${scope}；本段 ${segmentId} 未变`;
}

function governanceChangeLabel(
  change: NonNullable<SegmentCycleSummary['governanceImpact']>['changes'][number],
  approvalState: NonNullable<SegmentCycleSummary['approval']>['state'] | null,
): string {
  const edge =
    change.sourceVersion !== null && change.targetVersion !== null
      ? `v${change.sourceVersion} → v${change.targetVersion}`
      : null;
  const proposed = approvalState === 'pending' ? '拟' : '';
  if (change.action === 'modify')
    return edge ? `${proposed}演进 ${change.unitId}：${edge}` : `${proposed}演进 ${change.unitId}（版本待结算）`;
  if (change.action === 'rollback')
    return edge ? `${proposed}回退 ${change.unitId}：${edge}` : `${proposed}回退 ${change.unitId}（版本待结算）`;
  if (change.action === 'add') {
    return change.targetVersion === null ? `新增 ${change.unitId}` : `新增 ${change.unitId}：v${change.targetVersion}`;
  }
  return `${change.action === 'enable' ? '启用' : '停用'} ${change.unitId}`;
}

function ApprovalBadge({ state }: { state: NonNullable<SegmentCycleSummary['approval']>['state'] }) {
  return (
    <SettingsBadge tone={state === 'approved' ? 'emerald' : state === 'rejected' ? 'red' : 'amber'} size="xxs">
      {approvalLabel(state)}
    </SettingsBadge>
  );
}

function decisionLabel(decision: NonNullable<SegmentCycleSummary['governance']>['decision']) {
  return { keep: '保持', rollback: '回退', evolve: '演进' }[decision];
}

function decisionTone(decision: NonNullable<SegmentCycleSummary['governance']>['decision']) {
  return decision === 'keep' ? ('emerald' as const) : ('amber' as const);
}

function approvalLabel(state: NonNullable<SegmentCycleSummary['approval']>['state']) {
  return { pending: '待审批', approved: '已批准', skipped: '已跳过', rejected: '已拒绝' }[state];
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="w-[76px] shrink-0 text-cafe-muted">{label}</span>
      <span className="min-w-0 text-cafe-secondary">{children}</span>
    </div>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
      <SettingsText as="p" variant="xs" tone="muted">
        {text}
      </SettingsText>
    </div>
  );
}
