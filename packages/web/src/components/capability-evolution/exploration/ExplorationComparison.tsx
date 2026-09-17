import { type EvolutionExplorationMetricV1, type EvolutionExplorationRecordV1, refIdentity } from '@cat-cafe/shared';
import { ExplorationBehavior, measurementText } from './ExplorationBehavior';
import { ExplorationIcon } from './ExplorationIcon';
import { ExplorationMedia } from './ExplorationMedia';
import { explorationTraceBounds } from './ExplorationTrace';
import { compareExplorationRecords, type ExplorationComparisonSide } from './exploration-comparison';

function MetricPair({
  metric,
  left,
  right,
}: {
  metric: EvolutionExplorationMetricV1;
  left: number | null | undefined;
  right: number | null | undefined;
}) {
  const values = [left, right].filter((value): value is number => value != null);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const x = (value: number) => 10 + ((value - min) / (max - min || 1)) * 230;
  return (
    <div className="exploration-metric-pair">
      <span>{metric.label}</span>
      <svg
        viewBox="0 0 250 42"
        role="img"
        aria-label={`${metric.label}：对照 ${measurementText(left, metric.unit)}，阅读 ${measurementText(right, metric.unit)}`}
      >
        <line x1={x(0)} x2={x(0)} y1="1" y2="41" className="exploration-chart-zero" />
        {[left, right].map((value, index) =>
          value == null ? null : (
            <rect
              key={index === 0 ? 'baseline' : 'selected'}
              className={index === 0 ? 'exploration-series-a' : 'exploration-series-b'}
              x={Math.min(x(0), x(value))}
              y={index * 20 + 3}
              width={Math.max(1, Math.abs(x(value) - x(0)))}
              height="12"
              rx="2"
            />
          ),
        )}
      </svg>
      <div>
        <span>对照 {measurementText(left, metric.unit)}</span>
        <span>阅读 {measurementText(right, metric.unit)}</span>
      </div>
    </div>
  );
}

function Distribution({ side, label }: { side: ExplorationComparisonSide; label: string }) {
  return (
    <section>
      <h4>
        {label} · {side.records.length} 条记录
      </h4>
      <p className="exploration-caption">{side.experiment.conditions.sampleSet.label}；不将两侧行号当作配对。</p>
      {side.experiment.metrics.map((metric) => {
        const values = side.records
          .map((record) => record.values[metric.key])
          .filter((value): value is number => value != null);
        return (
          <details key={metric.key}>
            <summary>
              {metric.label} ·{' '}
              {values.length
                ? `${measurementText(Math.min(...values), metric.unit)} 至 ${measurementText(Math.max(...values), metric.unit)}`
                : '数值缺失'}
            </summary>
            <p>{metric.definition}</p>
            <ul>
              {side.records.map((record) => (
                <li key={refIdentity(record.recordRef)}>
                  {record.label}：{measurementText(record.values[metric.key], metric.unit)}
                </li>
              ))}
            </ul>
          </details>
        );
      })}
      <p className="exploration-caption">此处展示原始分布范围；未发布效应区间时，不推断显著性。</p>
    </section>
  );
}

export function ExplorationComparison({
  programId,
  left,
  right,
  scope,
  scopeKey,
  selectedCaseId,
  onScope,
  onSelectCase,
  onRetry,
}: {
  programId: string;
  left: ExplorationComparisonSide;
  right: ExplorationComparisonSide;
  scope: 'full' | 'paired_subset';
  scopeKey?: string;
  selectedCaseId?: string;
  onScope(scope: 'full' | 'paired_subset'): void;
  onSelectCase(id: string): void;
  onRetry(): void;
}) {
  const result = compareExplorationRecords(left, right, scope, scopeKey);
  const pair =
    result.pairs.find((pair) => pair.right.caseId === selectedCaseId) ?? (selectedCaseId ? undefined : result.pairs[0]);
  const regressions = result.pairs.filter(
    (pair) => pair.left.result.status === 'satisfied' && pair.right.result.status === 'violated',
  );
  const unconfirmed = result.pairs.filter(
    (pair) =>
      pair.left.result.status === 'satisfied' &&
      (pair.right.result.status === 'unknown' || pair.right.result.status === 'observed'),
  );
  const pairLabel = (value: (typeof result.pairs)[number]) =>
    value.left.label === value.right.label ? value.right.label : `对照 ${value.left.label} · 阅读 ${value.right.label}`;
  const metrics = right.experiment.metrics.filter((metric) =>
    left.experiment.metrics.some(
      (entry) =>
        entry.key === metric.key &&
        entry.unit === metric.unit &&
        refIdentity(entry.sourceRef) === refIdentity(metric.sourceRef),
    ),
  );
  const count = (side: 'left' | 'right') =>
    result.pairs.filter((pair) => pair[side].result.status === 'satisfied').length;
  const traceBounds =
    pair?.left.trace && pair.right.trace ? explorationTraceBounds([pair.left.trace, pair.right.trace]) : undefined;
  const choose = (records: EvolutionExplorationRecordV1[]) => {
    const record = records[0];
    if (record) onSelectCase(record.caseId);
  };
  return (
    <section className="exploration-comparison" aria-label="所选实验对照" data-comparison-status={result.status}>
      <div className="exploration-section-heading">
        <h3>
          <ExplorationIcon kind="compare" />
          这次比较能说明什么
        </h3>
      </div>
      <div className="exploration-comparison-legend">
        <span className="exploration-legend-a">对照 · {left.experiment.title}</span>
        <span className="exploration-legend-b">阅读 · {right.experiment.title}</span>
      </div>
      {result.status === 'unavailable' ? (
        <div role="status" className="exploration-notice">
          <strong>当前条件下不能作效果比较</strong>
          <ul>
            {result.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p>两侧原有记录仍有效，需按适用条件补测或选择其它实验。</p>
        </div>
      ) : (
        <>
          {result.status === 'unpaired' ? (
            <>
              <p>{left.experiment.conditions.comparison.method}</p>
              <div className="exploration-pair">
                <Distribution side={left} label="对照" />
                <Distribution side={right} label="阅读" />
              </div>
            </>
          ) : (
            <>
              <p className="exploration-range">
                对照 {left.records.length} 条 · 阅读 {right.records.length} 条 · {result.pairs.length} 组相同输入
              </p>
              {(result.leftOnly.length > 0 || result.rightOnly.length > 0) && (
                <div className="exploration-notice">
                  <p>
                    两侧样本集合不同。仅在对照侧：{result.leftOnly.map((record) => record.label).join('、') || '无'}
                    ；仅在阅读侧：{result.rightOnly.map((record) => record.label).join('、') || '无'}。
                  </p>
                  {result.status === 'scope_required' ? (
                    <button type="button" onClick={() => onScope('paired_subset')}>
                      仅比较共同的 {result.pairs.length} 个场景
                    </button>
                  ) : (
                    <p>
                      已明确只比较上述 {result.pairs.length} 组配对，不能外推到整批胜出。
                      <button type="button" onClick={() => onScope('full')}>
                        返回完整范围
                      </button>
                    </p>
                  )}
                </div>
              )}
              {result.status === 'paired' && (
                <>
                  <div className="exploration-comparison-counts">
                    <button type="button" onClick={() => choose(result.pairs.map((pair) => pair.right))}>
                      本次判据：对照{' '}
                      <strong>
                        {count('left')}/{result.pairs.length}
                      </strong>{' '}
                      · 阅读{' '}
                      <strong>
                        {count('right')}/{result.pairs.length}
                      </strong>
                    </button>
                    <span>
                      {right.experiment.conditions.threshold.status === 'unknown'
                        ? '效用门槛未冻结'
                        : right.experiment.conditions.threshold.detail}
                    </span>
                  </div>
                  {regressions.length > 0 && (
                    <div className="exploration-regressions">
                      <ExplorationIcon kind="warning" />
                      <strong>已知回归</strong>
                      {regressions.map((pair) => (
                        <button
                          type="button"
                          key={refIdentity(pair.right.recordRef)}
                          onClick={() => onSelectCase(pair.right.caseId)}
                        >
                          {pairLabel(pair)} · {pair.right.result.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {unconfirmed.length > 0 && (
                    <div className="exploration-regressions" role="group" aria-label="原有达标尚待确认">
                      <ExplorationIcon kind="warning" />
                      <strong>原有达标尚待确认</strong>
                      {unconfirmed.map((item) => (
                        <button
                          type="button"
                          key={refIdentity(item.right.recordRef)}
                          onClick={() => onSelectCase(item.right.caseId)}
                        >
                          {pairLabel(item)} · {item.right.result.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="exploration-pair-cases" role="group" aria-label="全部配对案例">
                    {result.pairs.map((pair) => (
                      <button
                        type="button"
                        key={refIdentity(pair.right.recordRef)}
                        aria-pressed={selectedCaseId === pair.right.caseId}
                        onClick={() => onSelectCase(pair.right.caseId)}
                      >
                        {pairLabel(pair)}
                      </button>
                    ))}
                  </div>
                  {pair ? (
                    <>
                      <h4 className="exploration-pair-title">{pairLabel(pair)}</h4>
                      <div className="exploration-metric-pairs">
                        {metrics.slice(0, 3).map((metric) => (
                          <MetricPair
                            key={metric.key}
                            metric={metric}
                            left={pair.left.values[metric.key]}
                            right={pair.right.values[metric.key]}
                          />
                        ))}
                      </div>
                      {metrics.length > 3 && (
                        <p className="exploration-caption">
                          按来源顺序展示前 3 个量尺；另有 {metrics.length - 3} 个，可在下方实际输入、输出与判据中展开。
                        </p>
                      )}
                      <div className="exploration-pair">
                        <ExplorationMedia
                          key={`left:${refIdentity(pair.left.recordRef)}`}
                          programId={programId}
                          record={pair.left}
                          sideLabel="对照"
                          traceBounds={traceBounds}
                          onRetry={onRetry}
                        />
                        <ExplorationMedia
                          key={`right:${refIdentity(pair.right.recordRef)}`}
                          programId={programId}
                          record={pair.right}
                          sideLabel="阅读"
                          traceBounds={traceBounds}
                          onRetry={onRetry}
                        />
                      </div>
                      <details>
                        <summary>这一对的实际输入、输出与判据</summary>
                        <div className="exploration-pair">
                          <ExplorationBehavior record={pair.left} experiment={left.experiment} />
                          <ExplorationBehavior record={pair.right} experiment={right.experiment} />
                        </div>
                      </details>
                    </>
                  ) : (
                    <p className="exploration-notice">
                      当前阅读案例不在配对范围内。选择上方配对案例，或查看下方本次完整记录。
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      <details className="exploration-sources">
        <summary>比较方法与展示顺序</summary>
        <p>{left.experiment.conditions.comparison.method}</p>
        <p>
          配对按对照侧原场景顺序展示；两侧保持各自真实时间。重复记录不作为独立样本，公开开发集上的计数不代表真实世界效用。
        </p>
      </details>
    </section>
  );
}
