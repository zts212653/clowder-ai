'use client';

import { MemoryReadError } from './page/MemoryReadError';
import { useMemoryRead } from './page/use-memory-read';

interface FlagState {
  f200: { consumptionRerank: 'off' | 'shadow' | 'on' };
}

function isFlagState(value: unknown): value is FlagState {
  if (!value || typeof value !== 'object') return false;
  const mode = (value as FlagState).f200?.consumptionRerank;
  return mode === 'off' || mode === 'shadow' || mode === 'on';
}

const MODE_LABELS: Record<FlagState['f200']['consumptionRerank'], { label: string; color: string }> = {
  off: { label: '关闭', color: 'bg-zinc-600' },
  shadow: { label: '影子模式', color: 'bg-[var(--semantic-warning)]' },
  on: { label: '开启', color: 'bg-[var(--semantic-success)]' },
};

export function MemoryFlagPanel() {
  const { data: flags, error, retry } = useMemoryRead('/api/recall/flags', isFlagState);

  if (error) return <MemoryReadError noun="召回功能标志" retry={retry} />;

  if (!flags) return <p className="text-sm text-cafe-muted">加载中...</p>;

  const mode = flags.f200.consumptionRerank;
  const badge = MODE_LABELS[mode];

  return (
    <div className="rounded-lg bg-[var(--console-card-bg)] p-4" data-testid="memory-flag-panel">
      <h3 className="mb-3 text-sm font-medium text-cafe-text">召回功能标志</h3>
      <div className="flex items-center gap-3">
        <span className="text-xs text-cafe-muted">消费重排序</span>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium text-[var(--cafe-surface)] ${badge.color}`}
          data-testid="f200-rerank-badge"
        >
          {badge.label}
        </span>
      </div>
      <p className="mt-2 text-compact text-cafe-muted">这里显示实际生效的模式；调整沿用索引功能开关和系统配置。</p>
      {mode === 'shadow' && (
        <p className="mt-2 text-xs text-cafe-muted">
          影子模式：计算并记录评分，但不改变实际排序。请在 metrics 中查看 shadowConsumedMRR。
        </p>
      )}
    </div>
  );
}
