import { refIdentity } from '@cat-cafe/shared';
import { ExplorationOutcome } from './ExplorationOutcome';
import { explorationTraceBounds } from './ExplorationTrace';
import type { ExplorationComparison, ExplorationComparisonSide } from './exploration-comparison';
import { summarizePairChanges } from './exploration-decision-model';
import type { ExplorationReading } from './exploration-reading';

export function ExplorationPairedResults({
  programId,
  left,
  right,
  result,
  reading,
  onChange,
  onRetry,
}: {
  programId: string;
  left: ExplorationComparisonSide;
  right: ExplorationComparisonSide;
  result: ExplorationComparison;
  reading: ExplorationReading;
  onChange(patch: Partial<ExplorationReading>): void;
  onRetry(): void;
}) {
  const groups = summarizePairChanges(result.pairs);
  const filter = reading.caseFilter ?? 'all';
  const cases = filter === 'all' ? result.pairs : groups[filter];
  const pair = cases.find((item) => item.right.caseId === reading.selectedCaseId) ?? cases[0];
  const count = (side: 'left' | 'right') =>
    result.pairs.filter((item) => item[side].result.status === 'satisfied').length;
  const bounds =
    pair?.left.trace && pair.right.trace ? explorationTraceBounds([pair.left.trace, pair.right.trace]) : undefined;
  const filters = ['all', 'improved', 'regressed', 'unchanged', 'unknown'] as const;
  const labels = { all: '全部', improved: '改善', regressed: '退步', unchanged: '不变', unknown: '未知' };
  return (
    <section className="exploration-paired-results" aria-label="所选实验对照" data-comparison-status="paired">
      {(result.leftOnly.length > 0 || result.rightOnly.length > 0) && (
        <section className="exploration-notice" aria-label="本次比较范围">
          <p>仅比较共同的 {result.pairs.length} 个场景，不能外推到整批。</p>
          <p>
            未纳入本次比较：对照侧 {result.leftOnly.length} 条，本版侧 {result.rightOnly.length} 条。
          </p>
          <button type="button" onClick={() => onChange({ comparisonScope: 'full', comparisonScopeKey: undefined })}>
            返回完整范围
          </button>
          <details>
            <summary>查看未配对记录</summary>
            <p>仅在对照侧：{result.leftOnly.map((record) => record.label).join('、') || '无'}。</p>
            <p>仅在本版侧：{result.rightOnly.map((record) => record.label).join('、') || '无'}。</p>
          </details>
        </section>
      )}
      <div className="exploration-verdict">
        <div>
          <span>{right.experiment.conditions.measurement.label} · 符合判据</span>
          <p>
            <strong>
              {count('left')}/{result.pairs.length}
            </strong>
            <span aria-hidden="true"> → </span>
            <strong>
              {count('right')}/{result.pairs.length}
            </strong>
            <small>对照 → 本版</small>
          </p>
        </div>
        <p>
          {result.pairs.length} 组相同输入 · 按本次判据逐例比较
          <br />
          <span>{right.experiment.conditions.groundTruth.label}</span>
        </p>
      </div>
      <div className="exploration-slice-filters" role="group" aria-label="案例变化筛选">
        {filters.map((key) => {
          const length = key === 'all' ? result.pairs.length : groups[key].length;
          if (key === 'unknown' && !length) return null;
          return (
            <button
              key={key}
              type="button"
              data-slice={key}
              aria-pressed={filter === key}
              disabled={!length}
              onClick={() =>
                onChange({
                  caseFilter: key,
                  selectedCaseId: (key === 'all' ? result.pairs : groups[key])[0]?.right.caseId,
                })
              }
            >
              {labels[key]} {length}
            </button>
          );
        })}
      </div>

      <div className="exploration-evidence-focus">
        {cases.length > 1 && (
          <nav className="exploration-case-nav" aria-label="本次筛选的案例">
            {cases.map((item) => (
              <button
                type="button"
                key={refIdentity(item.right.recordRef)}
                aria-pressed={pair === item}
                onClick={() => onChange({ selectedCaseId: item.right.caseId })}
              >
                {item.right.label}
                <span>
                  {item.left.result.status === 'satisfied'
                    ? '通过'
                    : item.left.result.status === 'violated'
                      ? '未通过'
                      : '未知'}{' '}
                  →{' '}
                  {item.right.result.status === 'satisfied'
                    ? '通过'
                    : item.right.result.status === 'violated'
                      ? '未通过'
                      : '未知'}
                </span>
              </button>
            ))}
          </nav>
        )}
        <div className="exploration-pair-focus">
          {pair ? (
            <>
              <h3>{pair.right.label}</h3>
              <div className="exploration-pair">
                <ExplorationOutcome
                  key={`a:${refIdentity(pair.left.recordRef)}`}
                  programId={programId}
                  label="对照"
                  record={pair.left}
                  experiment={left.experiment}
                  retry={onRetry}
                  bounds={bounds}
                />
                <ExplorationOutcome
                  key={`b:${refIdentity(pair.right.recordRef)}`}
                  programId={programId}
                  label="本版"
                  record={pair.right}
                  experiment={right.experiment}
                  retry={onRetry}
                  bounds={bounds}
                />
              </div>
            </>
          ) : (
            <p>当前筛选下没有案例。可以切回全部。</p>
          )}
        </div>
      </div>
      <details className="exploration-pair-method">
        <summary>本次比较的方法与范围</summary>
        <p>{right.experiment.conditions.threshold.detail}</p>
        <p>{right.experiment.conditions.comparison.method}</p>
        <p>{right.experiment.conditions.limitation}</p>
        <p>计数仅覆盖本组记录。未知单列，不按任意数值的增减推断好坏。</p>
        <p>
          汇总增加不代表所有场景改善。存在退步：
          {groups.regressed.map((item) => item.right.label).join('、') || '本组未见'}。
        </p>
      </details>
    </section>
  );
}
