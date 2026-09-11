'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { catColorVar } from '@/lib/cat-slug';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { AppServerLifecycleSnapshot, AppServerLifecycleStage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { isSilentActiveTurn } from './capability-tip-placement';
import { ExecutionCancelButton } from './ExecutionCancelButton';
import { managedCommandActivityLabel } from './managed-command-activity-label';

const APP_SERVER_STAGE_LABELS: Record<AppServerLifecycleStage, string> = {
  child_spawned: '启动子进程',
  initialized: '初始化 app-server',
  thread_ready: '会话已就绪',
  turn_accepted: '回合已接受',
  active: '运行回合',
  completed: '回合完成',
  interrupted: '回合已中断',
  failed: '回合失败',
  closing: '清理进程',
  closed: '进程已关闭',
};

function formatActivityAge(lastActivityAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - lastActivityAt) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

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
        .filter((execution) => execution.threadId === effectiveThreadId)
        .sort((left, right) => left.startedAt - right.startedAt || left.executionId.localeCompare(right.executionId)),
    [effectiveThreadId, executionsByKey],
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
              lifecycle={
                execution.kind === 'live_invocation' ? catInvocations[execution.catId]?.appServerLifecycle : undefined
              }
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
  lifecycle,
}: {
  execution: ActiveExecutionProjection;
  label: string;
  color: string;
  lifecycle?: AppServerLifecycleSnapshot;
}) {
  const elapsed = Math.floor((Date.now() - execution.startedAt) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  const appServerStalled = isSilentActiveTurn(lifecycle);

  return (
    <span
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-cafe-surface/50"
      data-app-server-stalled={appServerStalled ? 'true' : undefined}
    >
      <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: color }} />
      <span className="text-cafe-secondary font-medium">{label}</span>
      <span className="text-cafe-muted">
        {execution.kind === 'managed_command' ? managedCommandActivityLabel(execution.activity) : '实时回合'} ·{' '}
        {execution.threadTitle ?? execution.threadId}
      </span>
      {lifecycle && (
        <span className={appServerStalled ? 'text-conn-amber-text' : 'text-cafe-muted'}>
          {APP_SERVER_STAGE_LABELS[lifecycle.stage]} ·{' '}
          {appServerStalled ? '可能在等待模型' : `活动 ${formatActivityAge(lifecycle.lastActivityAt)}`}
        </span>
      )}
      <span className="text-cafe-muted tabular-nums">{timeStr}</span>
      <ExecutionCancelButton execution={execution} label="×" />
    </span>
  );
}
