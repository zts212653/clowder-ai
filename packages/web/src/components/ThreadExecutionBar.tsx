'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useExecutionRecoveryVerification } from '@/hooks/useExecutionRecoveryVerification';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { catColorVar } from '@/lib/cat-slug';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { AppServerLifecycleSnapshot, AppServerLifecycleStage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { isSilentActiveTurn, isStreamingTipSuppressed } from './capability-tip-placement';
import { ExecutionCancelButton } from './ExecutionCancelButton';
import { ForceResetDialog } from './ForceResetDialog';

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
  const { catInvocations, catStatuses } = useThreadLiveness(effectiveThreadId);
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const executionHydration = useActiveExecutionStore((state) => state.hydration);
  const executionAnchorThreadId = useActiveExecutionStore((state) => state.anchorThreadId);
  const { getCatById } = useCatData();
  const [, setTick] = useState(0);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const activeExecutions = useMemo(
    () =>
      Object.values(executionsByKey)
        .filter((execution) => execution.threadId === effectiveThreadId)
        .sort((left, right) => left.startedAt - right.startedAt || left.executionId.localeCompare(right.executionId)),
    [effectiveThreadId, executionsByKey],
  );

  const { hasUnverifiedLegacyExecution } = useExecutionRecoveryVerification(threadId);

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

  // F220 Phase 3: 升级态判定 — 任一活跃猫疑似卡死（liveness warning）→ 入口上浮变醒目。
  const stalled = activeExecutions.some((execution) => {
    if (execution.kind !== 'live_invocation') return false;
    return isStreamingTipSuppressed(catStatuses[execution.catId], catInvocations[execution.catId]?.appServerLifecycle);
  });
  // F220 Phase 3: 确认后调 force-reset 端点（只清运行态，LL-048 不碰持久化）→ toast → 关弹窗。
  const handleForceReset = useCallback(async () => {
    if (!effectiveThreadId) return;
    setResetting(true);
    try {
      await apiFetch(`/api/threads/${effectiveThreadId}/force-reset`, { method: 'POST' });
      useToastStore.getState().addToast({
        type: 'success',
        title: '已重置',
        message: '对话已解放，可以发新消息了',
        duration: 4000,
      });
      setResetDialogOpen(false);
    } finally {
      setResetting(false);
    }
  }, [effectiveThreadId]);

  // Canonical truth is empty but unsettled while the legacy socket still reports a
  // live turn. Returning null here used to remove the force-reset entry — the only
  // escape — at exactly the moment the user needs it, because ChatInput
  // simultaneously hard-locks Cancel to `unavailable`. Keep a reachable exit.
  if (activeExecutions.length === 0 && hasUnverifiedLegacyExecution) {
    return (
      <div className="console-divider-b" data-testid="execution-unverified-recovery">
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs">
          <span className="text-cafe-muted shrink-0" title="本轮没有留下可核对的终态，可能已经结束。">
            运行状态待确认
          </span>
        </div>
        <ForceResetEntry escalated onClick={() => setResetDialogOpen(true)} />
        <ForceResetDialog
          open={resetDialogOpen}
          busy={resetting}
          onCancel={() => setResetDialogOpen(false)}
          onConfirm={handleForceReset}
        />
      </div>
    );
  }
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
              key={`${execution.kind}:${execution.executionId}`}
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
      <ForceResetEntry escalated={stalled} onClick={() => setResetDialogOpen(true)} />
      <ForceResetDialog
        open={resetDialogOpen}
        busy={resetting}
        onCancel={() => setResetDialogOpen(false)}
        onConfirm={handleForceReset}
      />
    </div>
  );
}

function TriangleAlertIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** F220 Phase 3: force-reset 入口。默认低调（dashed-top + 灰 + 小，藏面板底）；
 *  escalated（疑似卡死）时上浮变醒目（critical-surface 底 + 警告色）。 */
function ForceResetEntry({ escalated, onClick }: { escalated: boolean; onClick: () => void }) {
  if (escalated) {
    return (
      <div className="px-4 pb-1.5">
        <button
          type="button"
          data-testid="force-reset-entry"
          data-escalated="true"
          onClick={onClick}
          className="w-full flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-opacity hover:opacity-90"
          style={{
            backgroundColor: 'var(--semantic-critical-surface)',
            color: 'var(--semantic-critical)',
            border: '1px solid color-mix(in srgb, var(--semantic-critical) 30%, transparent)',
          }}
        >
          <TriangleAlertIcon className="w-3.5 h-3.5" />
          卡住了？强制重置
        </button>
      </div>
    );
  }
  return (
    <div className="px-4 pb-1.5">
      <button
        type="button"
        data-testid="force-reset-entry"
        data-escalated="false"
        onClick={onClick}
        className="flex items-center gap-1.5 w-full pt-1.5 border-t border-dashed border-cafe text-xs text-cafe-muted hover:text-cafe-secondary transition-colors"
      >
        <TriangleAlertIcon className="w-3 h-3 opacity-70" />
        卡住了？强制重置
      </button>
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
        {execution.kind === 'managed_command' ? '托管命令' : '实时回合'} · {execution.threadTitle ?? execution.threadId}
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
