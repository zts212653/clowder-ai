'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { catColorVar } from '@/lib/cat-slug';
import type { AppServerLifecycleSnapshot, AppServerLifecycleStage, CatInvocationInfo } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { isSilentActiveTurn, isStreamingTipSuppressed } from './capability-tip-placement';
import { ForceResetDialog } from './ForceResetDialog';
import { deriveActiveCats } from './status-helpers';

type ActiveInvocationSlots = Record<string, { catId: string; mode: string; startedAt?: number }>;

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

/** F122B AC-B8: Per-cat execution status bar.
 *  B8/B9 polish: cat names use formatCatName() — "品种（variant）" format, colors from cat-config. */
export function ThreadExecutionBar({ threadId }: ThreadExecutionBarProps) {
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const effectiveThreadId = threadId ?? currentThreadId;
  const {
    activeInvocations,
    catInvocations,
    catStatuses,
    hasActive: hasActiveInvocation,
    intentMode,
    targetCats,
  } = useThreadLiveness(effectiveThreadId);
  const { getCatById } = useCatData();
  const [, setTick] = useState(0);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const activeCats = deriveActiveCats({
    targetCats,
    activeInvocations,
    hasActiveInvocation,
    intentMode,
  }).map((catId) => ({
    catId,
    startedAt: getStartedAt(catId, activeInvocations, catInvocations),
    lifecycle: catInvocations[catId]?.appServerLifecycle,
  }));

  // Build display info from cat-config (dynamic, not hardcoded)
  const catDisplayMap = useMemo(() => {
    const map = new Map<string, { label: string; color: string }>();
    for (const { catId } of activeCats) {
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
  }, [activeCats, getCatById]);

  // Auto-update elapsed time every second when cats are active
  useEffect(() => {
    if (activeCats.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activeCats.length]);

  // A stalled turn makes Stop more visually urgent, but does not change its
  // scope: it always stops the complete thread run.
  const stalled = activeCats.some(({ catId, lifecycle }) => {
    return isStreamingTipSuppressed(catStatuses[catId], lifecycle);
  });
  const handleStopThread = useCallback(async () => {
    if (!effectiveThreadId) return;
    setResetting(true);
    try {
      await apiFetch(`/api/threads/${effectiveThreadId}/force-reset`, { method: 'POST' });
      useToastStore.getState().addToast({
        type: 'success',
        title: '已停止',
        message: '对话中的运行已停止，可以继续发送新消息了',
        duration: 4000,
      });
      setResetDialogOpen(false);
    } finally {
      setResetting(false);
    }
  }, [effectiveThreadId]);

  if (activeCats.length === 0) return null;

  return (
    <div className="console-divider-b">
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs">
        <span className="text-cafe-muted font-medium shrink-0">执行中</span>
        {activeCats.map(({ catId, startedAt, lifecycle }) => {
          const info = catDisplayMap.get(catId) ?? { label: catId, color: 'var(--cafe-accent)' };
          return (
            <CatStatusChip
              key={catId}
              label={info.label}
              color={info.color}
              startedAt={startedAt}
              lifecycle={lifecycle}
            />
          );
        })}
      </div>
      <StopConversationEntry escalated={stalled} onClick={() => setResetDialogOpen(true)} />
      <ForceResetDialog
        open={resetDialogOpen}
        busy={resetting}
        onCancel={() => setResetDialogOpen(false)}
        onConfirm={handleStopThread}
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

function StopConversationEntry({ escalated, onClick }: { escalated: boolean; onClick: () => void }) {
  if (escalated) {
    return (
      <div className="px-4 pb-1.5">
        <button
          type="button"
          data-testid="thread-stop-entry"
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
          停止对话
        </button>
      </div>
    );
  }
  return (
    <div className="px-4 pb-1.5">
      <button
        type="button"
        data-testid="thread-stop-entry"
        data-escalated="false"
        onClick={onClick}
        className="flex items-center gap-1.5 w-full pt-1.5 border-t border-dashed border-cafe text-xs text-cafe-muted hover:text-cafe-secondary transition-colors"
      >
        <TriangleAlertIcon className="w-3 h-3 opacity-70" />
        停止对话
      </button>
    </div>
  );
}

function getStartedAt(
  catId: string,
  activeInvocations: ActiveInvocationSlots,
  catInvocations: Record<string, CatInvocationInfo>,
) {
  const slot = Object.values(activeInvocations).find((inv) => inv.catId === catId);
  if (typeof slot?.startedAt === 'number') return slot.startedAt;

  const invocationStartedAt = catInvocations[catId]?.startedAt;
  if (typeof invocationStartedAt === 'number') return invocationStartedAt;

  return Date.now();
}

function CatStatusChip({
  label,
  color,
  startedAt,
  lifecycle,
}: {
  label: string;
  color: string;
  startedAt: number;
  lifecycle?: AppServerLifecycleSnapshot;
}) {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
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
      {lifecycle && (
        <span className={appServerStalled ? 'text-conn-amber-text' : 'text-cafe-muted'}>
          {APP_SERVER_STAGE_LABELS[lifecycle.stage]} ·{' '}
          {appServerStalled ? '可能在等待模型' : `活动 ${formatActivityAge(lifecycle.lastActivityAt)}`}
        </span>
      )}
      <span className="text-cafe-muted tabular-nums">{timeStr}</span>
    </span>
  );
}
