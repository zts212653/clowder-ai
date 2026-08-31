'use client';

import type {
  MetricResultValue,
  SegmentEvaluationResponse,
  SegmentMetricEvaluationView,
  SegmentObjectiveEvaluationView,
} from '@cat-cafe/shared';
import { SettingsBadge, SettingsText } from './primitives';

const formatTs = (value: number) => new Date(value).toLocaleString();

export function ObjectiveEvaluationPanel({ data }: { data: SegmentEvaluationResponse }) {
  if (data.objectives.length === 0) {
    return <EmptyCard text="该段尚未挂接 Objective；Tracing 仍会持续采集，但不会生成伪评估结果。" />;
  }
  return (
    <div className="space-y-4" data-testid="objective-evaluation-panel">
      {data.objectives.map((objective) => (
        <section
          key={`${objective.objectiveId}:${objective.unitRefs.map((ref) => ref.clauseId ?? ref.unitId).join(':')}`}
          className="rounded-2xl bg-[var(--console-panel-bg)] p-4"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <MetaRow label="归属">
              <span className="font-mono">{objective.objectiveId}</span>
              <span className="ml-2 text-cafe-muted">{objective.objectiveLabel}</span>
            </MetaRow>
            <MetaRow label="评估模型">
              <span className="font-mono">{objective.evaluationModelId}</span>
            </MetaRow>
          </div>
          <div className="mt-2">
            <MetaRow label="Objective 结论">
              {objective.latestJudgment ? (
                <JudgmentBadge completion={objective.latestJudgment.completion} />
              ) : (
                <SettingsText as="span" variant="xs" tone="muted">
                  该窗口内尚无完成评估
                </SettingsText>
              )}
            </MetaRow>
          </div>
          <div className="mt-4 space-y-3">
            {objective.metrics.map((metric) => (
              <MetricCard key={metric.metricId} metric={metric} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function MetricCard({ metric }: { metric: SegmentMetricEvaluationView }) {
  return (
    <article className="rounded-xl bg-[var(--console-card-bg)] p-3" data-metric-id={metric.metricId}>
      <div className="flex flex-wrap items-center gap-2">
        <SettingsText as="h4" variant="sm" tone="default" className="font-semibold">
          {metric.label}
        </SettingsText>
        <SettingsBadge
          tone={metric.kind === 'counter' ? 'amber' : metric.kind === 'rate' ? 'blue' : 'slate'}
          size="xxs"
        >
          {kindLabel(metric.kind)}
        </SettingsBadge>
      </div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        <MetaRow label="评估方式">{evaluatorLabel(metric.evaluatorKind)}</MetaRow>
        <MetaRow label="评估规则">
          <span className="font-mono">{metric.evaluatorRuleRef}</span>
        </MetaRow>
      </div>
      {metric.latestEvaluation ? (
        <div className="mt-3 rounded-lg bg-[var(--console-elevated-bg)] p-2">
          <MetaRow label="最近结果">{resultLabel(metric.latestEvaluation.result.value)}</MetaRow>
          <MetaRow label="评估时间">{formatTs(metric.latestEvaluation.result.evaluatedAt)}</MetaRow>
          <MetaRow label="评估窗口">
            {formatTs(metric.latestEvaluation.window.start)} ~ {formatTs(metric.latestEvaluation.window.end)}
          </MetaRow>
        </div>
      ) : (
        <SettingsText as="p" variant="xs" tone="muted" className="mt-3 italic">
          尚无评估结果；Tracing 与分类继续进行，不阻塞当前版本。
        </SettingsText>
      )}
    </article>
  );
}

function JudgmentBadge({
  completion,
}: {
  completion: NonNullable<SegmentObjectiveEvaluationView['latestJudgment']>['completion'];
}) {
  const labels = {
    complete: '已完成',
    insufficient_evidence: '证据不足',
    partial: '部分完成',
  };
  const tone: Record<string, 'emerald' | 'amber' | 'slate' | 'red'> = {
    complete: 'emerald',
    insufficient_evidence: 'amber',
    partial: 'red',
  };
  return (
    <SettingsBadge tone={tone[completion] ?? 'slate'} size="xxs">
      {labels[completion] ?? completion}
    </SettingsBadge>
  );
}

function resultLabel(value: MetricResultValue): string {
  if (value.kind === 'counter') {
    return `明确反例 ${value.count} 次（判断阈值 ${value.threshold}）`;
  }
  if (value.kind === 'rate') {
    return `${value.numerator}/${value.denominator}（${(value.rate * 100).toFixed(1)}%）`;
  }
  if (value.kind === 'replay') return `通过 ${value.passed} / 失败 ${value.failed}`;
  return `${Object.entries(value.labels)
    .map(([label, count]) => `${label} ${count}`)
    .join('；')} — ${value.explanation}`;
}

function kindLabel(kind: SegmentMetricEvaluationView['kind']): string {
  if (kind === 'counter') return '明确反例';
  if (kind === 'rate') return '比率';
  if (kind === 'semantic') return '语义评估';
  return '回放评估';
}

function evaluatorLabel(kind: SegmentMetricEvaluationView['evaluatorKind']): string {
  if (kind === 'code') return '结构化规则';
  if (kind === 'llm') return '后台 LLM 语义分析';
  return '固定回放样例';
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="w-[72px] shrink-0 text-cafe-muted">{label}</span>
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
