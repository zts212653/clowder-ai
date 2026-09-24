'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { catColorVar } from '@/lib/cat-slug';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { ExecutionCancelButton } from './ExecutionCancelButton';

interface ThreadExecutionBarProps {
  threadId?: string;
}

/** F122B AC-B8+B9: Per-cat execution status bar with stop controls.
 *  B8/B9 polish: cat names use formatCatName() — "品种（variant）" format, colors from cat-config. */
export function ThreadExecutionBar({ threadId }: ThreadExecutionBarProps) {
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const effectiveThreadId = threadId ?? currentThreadId;
  const { catInvocations } = useThreadLiveness(effectiveThreadId);
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const executionHydration = useActiveExecutionStore((state) => state.hydration);
  const executionAnchorThreadId = useActiveExecutionStore((state) => state.anchorThreadId);
  const { getCatById } = useCatData();
  const [, setTick] = useState(0);

  const activeExecutions = useMemo(
    () =>
      Object.values(executionsByKey)
        .filter(
          (execution) =>
            execution.threadId === effectiveThreadId &&
            (execution.kind === 'managed_command' || Boolean(catInvocations[execution.catId]?.activeRun)),
        )
        .sort((left, right) => left.startedAt - right.startedAt || left.executionId.localeCompare(right.executionId)),
    [catInvocations, effectiveThreadId, executionsByKey],
  );

  // Build display info from cat-config (dynamic, not hardcoded)
  const catDisplayMap = useMemo(() => {
    const map = new Map<string, { label: string; color: string }>();
    for (const { catId } of activeExecutions) {
      const cat = getCatById(catId);
      if (cat) {
        map.set(catId, {
          label: formatCatName(cat),
          color: catColorVar(cat.id, 'primary'),
        });
      } else {
        map.set(catId, { label: catId, color: 'var(--cafe-accent)' });
      }
    }
    return map;
  }, [activeExecutions, getCatById]);

  // Auto-update elapsed time every second when cats are active
  useEffect(() => {
    if (activeExecutions.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activeExecutions.length]);

  if (activeExecutions.length === 0) return null;

  return (
    <div className="console-divider-b">
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs">
        <span className="text-cafe-muted font-medium shrink-0">执行中</span>
        {executionHydration === 'error' && executionAnchorThreadId === effectiveThreadId && (
          <span
            data-testid="execution-hydration-stale"
            className="text-micro text-conn-amber-text shrink-0"
            title="同步暂时失败，显示最近一次已验证状态。"
          >
            状态暂不可核对
          </span>
        )}
        {activeExecutions.map((execution) => {
          const info = catDisplayMap.get(execution.catId) ?? {
            label: execution.catId,
            color: 'var(--cafe-accent)',
          };
          return (
            <CatStatusChip
              key={activeExecutionKey(execution)}
              execution={execution}
              label={info.label}
              color={info.color}
            />
          );
        })}
      </div>
    </div>
  );
}

function CatStatusChip({
  execution,
  label,
  color,
}: {
  execution: ActiveExecutionProjection;
  label: string;
  color: string;
}) {
  const elapsed = Math.floor((Date.now() - execution.startedAt) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  return (
    <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-cafe-surface/50">
      <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: color }} />
      <span className="text-cafe-secondary font-medium">{label}</span>
      <span className="text-cafe-muted tabular-nums">{timeStr}</span>
      <ExecutionCancelButton execution={execution} label="×" />
    </span>
  );
}
