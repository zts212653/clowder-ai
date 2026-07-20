'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { catColorVar } from '@/lib/cat-slug';
import type { CatInvocationInfo } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { ForceResetDialog } from './ForceResetDialog';
import { deriveActiveCats } from './status-helpers';

type ActiveInvocationSlots = Record<string, { catId: string; mode: string; startedAt?: number }>;

interface ThreadExecutionBarProps {
  threadId?: string;
}

/** F122B AC-B8+B9: Per-cat execution status bar with stop controls.
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
  }).map((catId) => ({ catId, startedAt: getStartedAt(catId, activeInvocations, catInvocations) }));

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

  const handleStopCat = useCallback(
    async (catId: string) => {
      if (!effectiveThreadId) return;
      await apiFetch(`/api/threads/${effectiveThreadId}/cancel/${catId}`, { method: 'POST' });
    },
    [effectiveThreadId],
  );

  const handleStopAll = useCallback(async () => {
    if (!effectiveThreadId) return;
    await Promise.all(activeCats.map(({ catId }) => handleStopCat(catId)));
  }, [effectiveThreadId, activeCats, handleStopCat]);

  // F220 Phase 3: 升级态判定 — 任一活跃猫疑似卡死（liveness warning）→ 入口上浮变醒目。
  const stalled = activeCats.some(({ catId }) => {
    const s = catStatuses[catId];
    return s === 'suspected_stall' || s === 'alive_but_silent';
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

  if (activeCats.length === 0) return null;

  return (
    <div className="console-divider-b">
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs">
        <span className="text-cafe-muted font-medium shrink-0">执行中</span>
        {activeCats.map(({ catId, startedAt }) => {
          const info = catDisplayMap.get(catId) ?? { label: catId, color: 'var(--cafe-accent)' };
          return (
            <CatStatusChip
              key={catId}
              catId={catId}
              label={info.label}
              color={info.color}
              startedAt={startedAt}
              onStop={handleStopCat}
            />
          );
        })}
        {activeCats.length > 1 && (
          <button
            type="button"
            onClick={handleStopAll}
            className="ml-auto text-xs text-cafe-muted hover:text-conn-red-text transition-colors shrink-0"
          >
            全部停止
          </button>
        )}
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
  catId,
  label,
  color,
  startedAt,
  onStop,
}: {
  catId: string;
  label: string;
  color: string;
  startedAt: number;
  onStop: (catId: string) => void;
}) {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  return (
    <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-cafe-surface/50">
      <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: color }} />
      <span className="text-cafe-secondary font-medium">{label}</span>
      <span className="text-cafe-muted tabular-nums">{timeStr}</span>
      <button
        type="button"
        onClick={() => onStop(catId)}
        className="ml-0.5 text-cafe-muted hover:text-conn-red-text transition-colors"
        aria-label={`Stop ${label}`}
      >
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </span>
  );
}
