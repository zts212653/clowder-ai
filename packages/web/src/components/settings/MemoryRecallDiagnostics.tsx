'use client';

import { useMemoryRead } from '../memory/page/use-memory-read';
import { RECALL_WINDOWS, ThreeAxisSection, type ThreeAxisSnapshot } from '../memory/RecallLedgerThreeAxis';

function isThreeAxis(value: unknown): value is ThreeAxisSnapshot {
  if (!value || typeof value !== 'object') return false;
  const data = value as ThreeAxisSnapshot;
  return (
    RECALL_WINDOWS.includes(data.days as 7 | 14 | 30) &&
    [data.harmfulConsumption, data.unmetDemandLowerBound, data.attentionCost].every(
      (axis) =>
        axis &&
        Number.isFinite(axis.value) &&
        ['measured', 'estimated', 'lower-bound', 'no-data'].includes(axis.maturity),
    )
  );
}

export function MemoryRecallDiagnostics() {
  const week = useMemoryRead('/api/recall/lifecycle/three-axis?days=7', isThreeAxis);
  const fortnight = useMemoryRead('/api/recall/lifecycle/three-axis?days=14', isThreeAxis);
  const month = useMemoryRead('/api/recall/lifecycle/three-axis?days=30', isThreeAxis);
  const reads = [week, fortnight, month];
  const available = reads.filter((read) => read.data !== null).length;
  return (
    <section aria-label="召回三轴观测" className="min-w-0 rounded-xl bg-[var(--console-card-bg)] p-4">
      <h3 className="text-base font-medium">召回三轴观测</h3>
      <p className="mt-2 text-compact text-cafe-muted">三个时间窗独立读取；估算、下界和无数据沿用生产者的口径。</p>
      {reads.some((read) => read.error) && (
        <p role="status" className="mt-3 text-compact text-cafe-muted">
          {available ? `部分读到：${available} 个时间窗已核对。` : '三轴观测暂不可用。'}
        </p>
      )}
      <ThreeAxisSection
        snapshots={{ 7: week.data, 14: fortnight.data, 30: month.data }}
        loading={reads.some((read) => read.loading)}
      />
      <div className="mt-3 flex flex-wrap gap-3">
        {reads.map(
          (read, index) =>
            read.error && (
              <button
                key={RECALL_WINDOWS[index]}
                type="button"
                onClick={read.retry}
                className="text-compact text-cafe-accent underline"
              >
                重读 {RECALL_WINDOWS[index]} 天观测
              </button>
            ),
        )}
      </div>
    </section>
  );
}
