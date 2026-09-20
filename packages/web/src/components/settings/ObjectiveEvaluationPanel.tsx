'use client';

import type {
  CycleMetricConclusion,
  MetricVerdictRule,
  SegmentEvaluationResponse,
  SegmentMetricEvaluationView,
  SegmentObjectiveEvaluationView,
} from '@cat-cafe/shared';
import { openInvocationTrajectory } from '@/components/workspace/trajectory/trajectory-navigation';
import { SettingsBadge, SettingsText } from './primitives';

const formatTs = (value: number) => new Date(value).toLocaleString();

export function ObjectiveEvaluationPanel({ data }: { data: SegmentEvaluationResponse }) {
  if (data.objectives.length === 0) {
    return <EmptyCard text="该段尚未挂接 Objective；Tracing 会持续采集，但不会生成伪评估结论。" />;
  }
  return (
    <div className="space-y-4" data-testid="objective-evaluation-panel">
      {data.objectives.map((objective) => (
        <section key={objective.objectiveId} className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <MetaRow label="归属">
              <span className="font-mono">{objective.objectiveId}</span>
              <span className="ml-2 text-cafe-muted">{objective.objectiveLabel}</span>
            </MetaRow>
            <MetaRow label="评估模型">
              {objective.evaluationModelLabel} · <span className="font-mono">{objective.ruleVersion}</span>
            </MetaRow>
            <MetaRow label="评估目标">{objective.objectiveStatement}</MetaRow>
            <MetaRow label="评估状态">
              <EvalStatusBadge status={objective.selectedCycle?.evalStatus ?? 'idle'} />
            </MetaRow>
          </div>
          <MetricCatalog metrics={objective.metrics} />
          {objective.latestEvaluation ? (
            <VerdictCard objective={objective} />
          ) : (
            <SettingsText as="p" variant="xs" tone="muted" className="mt-3">
              {objective.selectedCycle?.evalStatus === 'idle'
                ? '本周期尚未进入评估；当前仅展示指标定义。'
                : '本周期尚未回写评估结论；当前仅展示指标定义。'}
            </SettingsText>
          )}
        </section>
      ))}
    </div>
  );
}

function MetricCatalog({ metrics }: { metrics: SegmentMetricEvaluationView[] }) {
  return (
    <div className="mt-4 space-y-3">
      <SettingsText as="h3" variant="xs" tone="muted" className="font-semibold">
        指标目录
      </SettingsText>
      {metrics.map((metric) => (
        <article key={metric.metricId} className="rounded-xl bg-[var(--console-card-bg)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <SettingsText as="h4" variant="sm" tone="default" className="font-semibold">
              {metric.label}
            </SettingsText>
            <SettingsBadge tone="slate" size="xxs">
              {metric.metricId}
            </SettingsBadge>
          </div>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            <MetaRow label="方向">{directionLabel(metric.verdictRule)}</MetaRow>
            <MetaRow label="含义">{ruleLabel(metric.verdictRule)}</MetaRow>
            <MetaRow label="评估方式">{evaluatorLabel(metric.evaluatorKind)}</MetaRow>
            <MetaRow label="评估规则">
              <span className="font-mono">{metric.evaluatorRuleRef}</span>
            </MetaRow>
          </div>
        </article>
      ))}
    </div>
  );
}

function VerdictCard({ objective }: { objective: SegmentObjectiveEvaluationView }) {
  const evaluation = objective.latestEvaluation;
  if (!evaluation) return null;
  const evidenceRefs = [
    ...new Set([
      ...objective.metrics.flatMap((metric) => metric.evidenceRefs),
      ...(evaluation.coverageAssessment?.findings.flatMap((finding) => finding.evidenceRefs) ?? []),
    ]),
  ];
  return (
    <section className="mt-4 rounded-xl bg-[var(--console-elevated-bg)] p-3" data-testid="cycle-verdict-card">
      <div className="flex flex-wrap items-center gap-2">
        <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
          本周期评估结论
        </SettingsText>
        <SettingsBadge tone={evaluation.overall === 'complete' ? 'emerald' : 'amber'} size="xxs">
          {overallLabel(evaluation.overall)}
        </SettingsBadge>
        <SettingsText as="span" variant="xs" tone="muted">
          {formatTs(evaluation.writtenAt)}
        </SettingsText>
      </div>
      <div className="mt-3 space-y-1.5">
        {evaluation.overall === 'insufficient_evidence' && (
          <div className="rounded-lg bg-[var(--console-card-bg)] px-3 py-2 text-xs text-cafe-secondary">
            证据不足，本周期不进入治理；已并入下一周期继续累计。
          </div>
        )}
        <MetaRow label="评估者">@{evaluation.by}</MetaRow>
        <MetaRow label="评估时间">{formatTs(evaluation.writtenAt)}</MetaRow>
        <MetaRow label="评估窗口">
          {evaluation.windows.map((window) => `${formatTs(window.start)} → ${formatTs(window.end)}`).join('；')}
        </MetaRow>
        {objective.metrics.map((metric) => (
          <MetaRow key={metric.metricId} label={metric.label}>
            {metric.latestConclusion ? conclusionLabel(metric.latestConclusion) : '本轮未回写'}
          </MetaRow>
        ))}
        {evaluation.coverageAssessment && (
          <>
            <MetaRow label="检测覆盖">
              {coverageStatusLabel(evaluation.coverageAssessment.status)} · {evaluation.coverageAssessment.rationale}
            </MetaRow>
            {evaluation.coverageAssessment.findings.map((finding, index) => (
              <MetaRow key={`${finding.kind}:${index}`} label={coverageFindingLabel(finding)}>
                {finding.rationale}
              </MetaRow>
            ))}
          </>
        )}
        <MetaRow label="现在要做">{nextActionLabel(objective)}</MetaRow>
        <MetaRow label="下次看什么">{nextObservationLabel(objective)}</MetaRow>
      </div>
      {evidenceRefs.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {evidenceRefs.map((ref) => {
            const invocationId = ref.startsWith('invocation://') ? ref.slice('invocation://'.length) : ref;
            return (
              <button
                type="button"
                key={ref}
                onClick={() => openInvocationTrajectory({ invocationId })}
                className="rounded-lg bg-[var(--console-card-bg)] px-2 py-1 font-mono text-micro text-cafe-accent hover:brightness-95"
              >
                {invocationId}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function coverageStatusLabel(
  value: NonNullable<NonNullable<SegmentObjectiveEvaluationView['latestEvaluation']>['coverageAssessment']>['status'],
): string {
  if (value === 'adequate') return '覆盖充分';
  if (value === 'data_insufficient') return '数据不足';
  return '发现覆盖缺口';
}

function coverageFindingLabel(
  finding: NonNullable<
    NonNullable<SegmentObjectiveEvaluationView['latestEvaluation']>['coverageAssessment']
  >['findings'][number],
): string {
  if (finding.kind === 'metric_gap') return '指标缺口';
  return `检测器缺口 · ${finding.metricId}`;
}

function EvalStatusBadge({
  status,
}: {
  status: NonNullable<SegmentObjectiveEvaluationView['currentCycle']>['evalStatus'];
}) {
  const labels = {
    idle: '采集中',
    requested: '评估中',
    retriggered: '已重触发',
    written: '已回写',
    stalled: '评估停滞',
  };
  return (
    <SettingsBadge tone={status === 'stalled' ? 'red' : status === 'written' ? 'emerald' : 'blue'} size="xxs">
      {labels[status]}
    </SettingsBadge>
  );
}

function conclusionLabel(conclusion: CycleMetricConclusion): string {
  if (conclusion.kind === 'count') return `${conclusion.value} · ${conclusion.howCounted}`;
  if (conclusion.kind === 'rate-badness') return `${(conclusion.value * 100).toFixed(1)}% · ${conclusion.howCounted}`;
  return `${conclusion.label} ${conclusion.count} · ${conclusion.howCounted}`;
}

function directionLabel(rule: MetricVerdictRule): string {
  return rule.kind === 'rate-minimum' ? '越高越好' : rule.kind === 'evidence-only' ? '保留证据向量' : '越低越好';
}

function ruleLabel(rule: MetricVerdictRule): string {
  if (rule.kind === 'counter-zero') return '反例计数应为 0';
  if (rule.kind === 'rate-maximum') return `坏事件率不高于 ${(rule.maximum * 100).toFixed(1)}%`;
  if (rule.kind === 'rate-minimum') return `达成率不低于 ${(rule.minimum * 100).toFixed(1)}%`;
  if (rule.kind === 'semantic-label-maximum') return `${rule.label} 不超过 ${rule.maximum}`;
  if (rule.kind === 'replay-zero-failure') return '固定回放零失败';
  return '结论随证据原样展示，不折叠成总分';
}

function evaluatorLabel(kind: SegmentMetricEvaluationView['evaluatorKind']): string {
  if (kind === 'code') return '结构化规则';
  if (kind === 'llm') return '评估线程语义分析';
  return '固定回放样例';
}

function overallLabel(value: NonNullable<SegmentObjectiveEvaluationView['latestEvaluation']>['overall']): string {
  if (value === 'complete') return '完整';
  if (value === 'partial') return '部分';
  return '证据不足';
}

function nextActionLabel(objective: SegmentObjectiveEvaluationView): string {
  const governance = objective.latestGovernance;
  if (!governance) return '等待同一 Objective 线程完成 governance';
  if (governance.approval?.state === 'pending') return '等待 operator 审批提案卡';
  if (governance.decision === 'keep') return '保持当前版本并进入下一周期';
  return governance.approval ? `提案卡已${approvalLabel(governance.approval.state)}` : '等待提案卡';
}

function nextObservationLabel(objective: SegmentObjectiveEvaluationView): string {
  const cycle = objective.selectedCycle;
  return cycle ? `${formatTs(cycle.cycleStart)} 起的新周期 · ${cycle.evalStatus}` : '等待首个周期初始化';
}

function approvalLabel(
  state: NonNullable<NonNullable<SegmentObjectiveEvaluationView['latestGovernance']>['approval']>['state'],
) {
  return { pending: '待审', approved: '批准', skipped: '跳过', rejected: '拒绝' }[state];
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="w-[84px] shrink-0 text-cafe-muted">{label}</span>
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
