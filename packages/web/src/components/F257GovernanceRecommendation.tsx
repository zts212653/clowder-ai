import type { ApprovalHubItem } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { F257GovernanceChanges } from './F257GovernanceChanges';
import { openInvocationTrajectory } from './workspace/trajectory/trajectory-navigation';

export function F257GovernanceRecommendation({ item }: { item: ApprovalHubItem }) {
  const header = asRecord(item.detail.header);
  const conclusions = asRecords(item.detail.conclusions);
  const metricVisuals = asRecords(item.detail.metricVisuals);
  const history = asRecords(item.detail.history);
  const changes = asRecords(item.detail.changes);
  const evidenceRefs = Array.isArray(item.detail.evidenceRefs) ? item.detail.evidenceRefs.map(String) : [];
  const latestRejectReason = Array.isArray(item.detail.rejectReasons)
    ? item.detail.rejectReasons.map(String).at(-1)
    : undefined;
  const coverageAssessment = asRecord(item.detail.coverageAssessment);
  const coverageFindings = asRecords(coverageAssessment.findings);
  return (
    <div className="space-y-2" data-testid="f257-harness-governance-recommendation">
      <div className="space-y-1 rounded-md border border-cafe-subtle/30 p-2" data-testid="f257-governance-header">
        <GovernanceHeader header={header} />
      </div>

      <GovernanceSection title="1 · 指标数据与变化" testId="f257-governance-metrics">
        <MetricComparisonChart
          metrics={metricVisuals}
          conclusions={conclusions}
          hasComparisonBaseline={item.detail.hasComparisonBaseline === true}
          isFirstCycle={item.detail.isFirstCycle === true}
        />
      </GovernanceSection>

      <GovernanceSection title="2 · 结论摘要" testId="f257-governance-conclusions">
        {conclusions.map((metric, index) => (
          <MetricConclusion key={`${String(metric.id ?? 'metric')}-${index}`} metric={metric} index={index} />
        ))}
        {item.detail.governanceReason != null && <p>治理判断：{String(item.detail.governanceReason)}</p>}
        {coverageAssessment.status != null && (
          <div className="space-y-1">
            <p>
              检测覆盖：{coverageLabel(String(coverageAssessment.status))} ·{' '}
              {String(coverageAssessment.rationale ?? '')}
            </p>
            {coverageFindings.map((finding, index) => (
              <p key={`${String(finding.kind)}:${index}`} className="pl-3 text-cafe-muted">
                {coverageFindingLabel(finding)}：{String(finding.rationale ?? '')}
              </p>
            ))}
          </div>
        )}
        {evidenceRefs.length > 0 ? (
          <details>
            <summary className="cursor-pointer opacity-70">证据引用（{evidenceRefs.length}）</summary>
            <ul className="mt-1 max-h-32 space-y-1 overflow-auto font-mono text-micro">
              {evidenceRefs.map((reference) => (
                <li key={reference}>
                  <button
                    type="button"
                    className="break-all text-left underline underline-offset-2"
                    onClick={() => openInvocationTrajectory({ invocationId: reference })}
                    data-testid="f257-governance-evidence-link"
                  >
                    {reference}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="opacity-60">本次结论未附证据引用。</p>
        )}
        <details>
          <summary className="cursor-pointer opacity-70">历史周期（{history.length}）</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-cafe-muted p-2 text-micro">
            {JSON.stringify(history, null, 2)}
          </pre>
        </details>
      </GovernanceSection>

      <GovernanceSection title="3 · 动作与差异" testId="f257-governance-changes">
        <F257GovernanceChanges changes={changes} />
      </GovernanceSection>

      <GovernanceSection title="4 · 人工决策" testId="f257-governance-lineage">
        <p>提案轮次：{String(item.detail.cardOrdinal ?? 1)}</p>
        {latestRejectReason !== undefined && <p>上一轮拒绝理由：{latestRejectReason}</p>}
        {item.detail.decisionReason != null && <p>本卡处理理由：{String(item.detail.decisionReason)}</p>}
      </GovernanceSection>
    </div>
  );
}

function coverageLabel(status: string): string {
  if (status === 'adequate') return '覆盖充分';
  if (status === 'data_insufficient') return '数据不足';
  return '发现覆盖缺口';
}

function coverageFindingLabel(finding: Record<string, unknown>): string {
  if (finding.kind === 'metric_gap') return '指标缺口';
  return finding.metricId ? `检测器缺口 · ${String(finding.metricId)}` : '检测器缺口';
}

function MetricComparisonChart({
  metrics,
  conclusions,
  hasComparisonBaseline,
  isFirstCycle,
}: {
  metrics: Array<Record<string, unknown>>;
  conclusions: Array<Record<string, unknown>>;
  hasComparisonBaseline: boolean;
  isFirstCycle: boolean;
}) {
  const conclusionById = new Map(conclusions.map((metric) => [String(metric.id ?? ''), asRecord(metric.conclusion)]));
  return (
    <div className="space-y-3" data-testid="f257-governance-deltas">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-cafe-secondary" role="group" aria-label="指标图例">
        {hasComparisonBaseline && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-cafe-secondary/35" aria-hidden="true" /> 上周期
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-[var(--semantic-success)]" aria-hidden="true" /> 本周期
        </span>
      </div>
      <div className="space-y-4">
        {metrics.map((metric) => (
          <MetricComparisonRow
            key={String(metric.id)}
            metric={metric}
            conclusion={conclusionById.get(String(metric.id ?? '')) ?? {}}
          />
        ))}
      </div>
      {!hasComparisonBaseline && (
        <p className="text-cafe-muted" data-testid="f257-governance-first-cycle">
          {isFirstCycle ? '首轮评估，暂无可比较的历史基线。' : '历史周期中没有相同指标的可比较基线。'}
        </p>
      )}
    </div>
  );
}

function MetricComparisonRow({
  metric,
  conclusion,
}: {
  metric: Record<string, unknown>;
  conclusion: Record<string, unknown>;
}) {
  const previous = numberField(metric, 'previousValue');
  const current = numberField(metric, 'currentValue') ?? 0;
  const delta = numberField(metric, 'delta');
  const maximum = Math.max(1, current, previous ?? 0);
  const kind = String(conclusion.kind ?? 'count');
  return (
    <div className="space-y-2" data-testid="f257-governance-metric-visual">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium">{String(metric.id ?? '未知指标')}</span>
        {delta !== null && (
          <span className={metricDeltaTone(metric, delta)} data-testid="f257-governance-metric-delta">
            较上周期 {formatSignedMetricValue(kind, delta)} · {metricDeltaMeaning(metric, delta)}
          </span>
        )}
      </div>
      <div className="space-y-1.5" role="img" aria-label={`${String(metric.id ?? '未知指标')}周期对比`}>
        {previous !== null && (
          <MetricBar
            label="上周期"
            value={previous}
            formattedValue={formatMetricValue(kind, previous)}
            maximum={maximum}
            tone="previous"
          />
        )}
        <MetricBar
          label="本周期"
          value={current}
          formattedValue={formatMetricValue(kind, current)}
          maximum={maximum}
          tone="current"
        />
      </div>
      {previous === null && <p className="text-xs text-cafe-muted">该指标暂无同名历史基线。</p>}
    </div>
  );
}

function MetricBar({
  label,
  value,
  formattedValue,
  maximum,
  tone,
}: {
  label: string;
  value: number;
  formattedValue: string;
  maximum: number;
  tone: 'previous' | 'current';
}) {
  const width = value <= 0 ? 0 : Math.max(3, (value / maximum) * 100);
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-2 text-xs">
      <span className="text-cafe-secondary">{label}</span>
      <span className="h-2.5 overflow-hidden rounded-full bg-cafe-muted/60">
        <span
          className={`block h-full rounded-full ${tone === 'current' ? 'bg-[var(--semantic-success)]' : 'bg-cafe-secondary/35'}`}
          style={{ width: `${width}%` }}
          data-testid={`f257-governance-metric-bar-${tone}`}
        />
      </span>
      <span className="min-w-10 text-right font-mono font-medium">{formattedValue}</span>
    </div>
  );
}

function MetricConclusion({ metric, index }: { metric: Record<string, unknown>; index: number }) {
  const conclusion = asRecord(metric.conclusion);
  const howCounted = stringField(conclusion, 'howCounted');
  return (
    <article className="rounded-lg bg-cafe-muted/45 px-3 py-2" data-testid="f257-governance-metric-conclusion">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{String(metric.id ?? `指标 ${index + 1}`)}</span>
        <span className="rounded-md bg-cafe-surface px-2 py-0.5 font-mono font-semibold">
          {formatConclusion(conclusion)}
        </span>
      </div>
      {howCounted && <p className="mt-1 break-words text-cafe-secondary">分析依据：{howCounted}</p>}
    </article>
  );
}

function GovernanceHeader({ header }: { header: Record<string, unknown> }) {
  const objective = asRecord(header.objective);
  const triggerCounts = asRecord(header.triggerCounts);
  const cumulative = asRecord(triggerCounts.cumulative);
  const counterexamples = asRecord(triggerCounts.counterexamples);
  const windows = asRecords(header.windows);
  const triggeredBy = Array.isArray(header.triggeredBy) ? header.triggeredBy.map(String) : [];
  return (
    <>
      <p>
        Objective：<span className="font-medium">{String(objective.label ?? header.objectiveId ?? '未知')}</span>
        {objective.id != null && <span className="opacity-60">（{String(objective.id)}）</span>}
      </p>
      <p>
        当前版本：{String(header.currentVersion ?? '未知')} · 建议：{String(header.decision ?? '未知')}
      </p>
      <p>本周期窗口：{windows.map(formatWindow).join('；') || '未知'}</p>
      <p>触发原因：{triggeredBy.join(' / ') || '未知'}</p>
      <p>
        周期内累计 {String(cumulative.count ?? '未知')}/{String(cumulative.threshold ?? '未知')} · 周期内反例{' '}
        {String(counterexamples.count ?? '未知')}/{String(counterexamples.threshold ?? '未知')}
      </p>
    </>
  );
}

function GovernanceSection({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section className="space-y-1 rounded-md border border-cafe-subtle/30 p-2" data-testid={testId}>
      <h4 className="font-semibold">{title}</h4>
      {children}
    </section>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === 'string' ? value[field] : undefined;
}

function formatConclusion(conclusion: Record<string, unknown>): string {
  if (conclusion.kind === 'rate-badness') {
    return `问题率 ${formatMetricValue('rate-badness', numberField(conclusion, 'value') ?? 0)}`;
  }
  if (conclusion.kind === 'semantic-label') {
    return `${String(conclusion.label ?? '未标注')} · ${formatNumber(numberField(conclusion, 'count') ?? 0)} 条`;
  }
  if (conclusion.kind === 'count') return `${formatNumber(numberField(conclusion, 'value') ?? 0)} 次`;
  return '暂未提供可读结论';
}

function formatMetricValue(kind: string, value: number): string {
  return kind === 'rate-badness' ? `${formatNumber(value * 100)}%` : formatNumber(value);
}

function formatSignedMetricValue(kind: string, value: number): string {
  const sign = value > 0 ? '+' : '';
  return kind === 'rate-badness' ? `${sign}${formatNumber(value * 100)} 个百分点` : `${sign}${formatNumber(value)}`;
}

function metricDeltaMeaning(metric: Record<string, unknown>, delta: number): string {
  if (delta === 0) return '持平';
  const lowerIsBetter = metric.lowerIsBetter === true;
  return (lowerIsBetter && delta < 0) || (!lowerIsBetter && delta > 0) ? '改善' : '恶化';
}

function metricDeltaTone(metric: Record<string, unknown>, delta: number): string {
  const meaning = metricDeltaMeaning(metric, delta);
  if (meaning === '改善') return 'text-xs font-medium text-[var(--semantic-success)]';
  if (meaning === '恶化') return 'text-xs font-medium text-[var(--semantic-critical)]';
  return 'text-xs font-medium text-cafe-secondary';
}

function formatWindow(window: Record<string, unknown>): string {
  const start = typeof window.start === 'number' ? new Date(window.start).toISOString() : '未知';
  const end = typeof window.end === 'number' ? new Date(window.end).toISOString() : '未知';
  return `${start} → ${end}`;
}

function numberField(value: Record<string, unknown>, field: string): number | null {
  return typeof value[field] === 'number' && Number.isFinite(value[field]) ? (value[field] as number) : null;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
