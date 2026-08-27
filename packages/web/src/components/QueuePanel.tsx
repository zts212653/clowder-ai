'use client';

import type { FreshnessCarrierCapability } from '@cat-cafe/shared';
import { type QueueReminderAttemptState, SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useCallback, useMemo, useState } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { composerInsertFromRecall, requestTrueRecall, TrueRecallRequestError } from '@/utils/true-recall';
import { SortableQueueEntryRow } from './QueueEntryRow';
import {
  collectExactLiveInvocationIds,
  projectQueueEntryForActions,
  queueEntryNeedsRecovery,
  queueTargetStateEntries,
} from './queue-receipt-projection';
import { SteerQueuedEntryModal } from './SteerQueuedEntryModal';
import { useQueueActionConvergence } from './useQueueActionConvergence';

const COLLAPSE_THRESHOLD = 4;

const PRIORITY_RANK: Record<string, number> = { urgent: 0, normal: 1 };

const REMINDER_RESULT_COPY: Record<
  QueueReminderAttemptState,
  { type: 'success' | 'info'; title: string; message: string }
> = {
  requested: {
    type: 'success',
    title: '提醒已请求',
    message: '不会打断当前工作；猫会在安全断点收到提示。',
  },
  delivered: { type: 'info', title: '提醒已送达', message: '猫已收到提示，尚未读取消息正文。' },
  seen: { type: 'info', title: '提醒后已读取', message: '猫已在该轮完整读取这条消息。' },
  missed: { type: 'info', title: '提醒未赶上本轮', message: '该轮已结束；回执保留本次未送达结果。' },
};

function reminderResultCopy(state: unknown) {
  return typeof state === 'string' && state in REMINDER_RESULT_COPY
    ? REMINDER_RESULT_COPY[state as QueueReminderAttemptState]
    : REMINDER_RESULT_COPY.requested;
}

export function compareQueueEntries(
  a: { position?: number; priority?: string; createdAt: number },
  b: { position?: number; priority?: string; createdAt: number },
): number {
  const aHasPos = a.position !== undefined;
  const bHasPos = b.position !== undefined;
  if (aHasPos && !bHasPos) return -1;
  if (!aHasPos && bHasPos) return 1;
  if (aHasPos && bHasPos) return a.position! - b.position!;
  const pDiff = (PRIORITY_RANK[a.priority ?? 'normal'] ?? 1) - (PRIORITY_RANK[b.priority ?? 'normal'] ?? 1);
  if (pDiff !== 0) return pDiff;
  return a.createdAt - b.createdAt;
}

/** Format an elapsed duration (ms) as a compact label: `45s` / `12m` / `1h03m`. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  return `${h}h${String(totalMin % 60).padStart(2, '0')}m`;
}

export type QueueWaitInfo =
  | { kind: 'active_turn'; catId: string; elapsedLabel: string | null }
  | { kind: 'target_dispatch'; catIds: string[] };

/**
 * Derive queue wait truth from both the queued work's explicit targets and live invocation slots.
 *
 * Explicit targets are authoritative: if none of those cats is active, the work is waiting for
 * target dispatch. An unrelated active cat must never be borrowed as the queue's blocker. Only
 * broadcast work (no explicit targets) may describe the oldest thread-level active turn.
 *
 * Pure: `now` injected for testing.
 */
export function computeQueueWaitInfo(
  activeInvocations: Record<string, { catId: string; mode?: string; startedAt?: number }> | undefined,
  queuedTargetCatIds: Iterable<string> = [],
  now: number = Date.now(),
): QueueWaitInfo | null {
  const slots = Object.values(activeInvocations ?? {});
  const targetCatIds = [...new Set(queuedTargetCatIds)];
  const targets = new Set(targetCatIds);
  const targeted = targetCatIds.length > 0 ? slots.filter((slot) => targets.has(slot.catId)) : [];

  if (targetCatIds.length > 0 && targeted.length === 0) {
    return { kind: 'target_dispatch', catIds: targetCatIds };
  }

  const candidates = targeted.length > 0 ? targeted : slots;
  if (candidates.length === 0) return null;
  let oldest = candidates[0];
  for (const s of candidates) {
    if ((s.startedAt ?? Number.POSITIVE_INFINITY) < (oldest.startedAt ?? Number.POSITIVE_INFINITY)) oldest = s;
  }
  return {
    kind: 'active_turn',
    catId: oldest.catId,
    elapsedLabel: oldest.startedAt ? formatElapsed(Math.max(0, now - oldest.startedAt)) : null,
  };
}

interface QueuePanelProps {
  threadId: string;
}

export function QueuePanel({ threadId }: QueuePanelProps) {
  const coCreator = useCoCreatorConfig();
  const resolveCatName = useCatNameResolver();
  const rawQueue = useChatStore((s) => s.queue);
  const queue = useMemo(() => rawQueue ?? [], [rawQueue]);
  const queuePaused = useChatStore((s) => s.queuePaused) ?? false;
  const queuePauseReason = useChatStore((s) => s.queuePauseReason);
  const setQueue = useChatStore((s) => s.setQueue);
  const { activeInvocations, catInvocations } = useThreadLiveness(threadId);
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const addToast = useToastStore((s) => s.addToast);

  const { steerEntryId, retryingAttemptIds, handleRetry, handleSteerConfirm, handleSteerOpen, handleSteerCancel } =
    useQueueActionConvergence(threadId);
  const [remindingTargetKeys, setRemindingTargetKeys] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<boolean | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const activeInvocationIds = useMemo(
    () => collectExactLiveInvocationIds(activeInvocations, catInvocations),
    [activeInvocations, catInvocations],
  );
  const activeCatIds = useMemo(
    () => new Set(Object.values(activeInvocations).map((invocation) => invocation.catId)),
    [activeInvocations],
  );
  const visibleEntries = useMemo(
    () =>
      queue
        .filter(
          (e) => e.status === 'queued' && !(e.source === 'connector' && e.content.startsWith(SCHEDULER_TRIGGER_PREFIX)),
        )
        .map((entry) => projectQueueEntryForActions(entry, activeInvocationIds))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort(compareQueueEntries),
    [activeInvocationIds, queue],
  );

  // A2A queue visibility: explain WHY entries are queued (waiting behind the active turn) so the
  // user can tell "waiting for the current turn" apart from "stuck". Passes the visible queued
  // entries' target cats so the wait reason attributes the RIGHT cat (per-cat slot), not just the
  // oldest active turn. Recomputed when activeInvocations/visibleEntries change; elapsed reflects
  // the last store update (acceptable for v1 — no per-second tick).
  const waitInfo = useMemo(() => {
    const dispatchTargetCatIds = visibleEntries.flatMap((entry) => {
      const targetStates = queueTargetStateEntries(entry);
      return targetStates.length > 0
        ? targetStates.filter(([, state]) => state !== 'seen' && state !== 'awakened').map(([catId]) => catId)
        : entry.targetCats;
    });
    const hasBroadcastEntry = visibleEntries.some(
      (entry) => queueTargetStateEntries(entry).length === 0 && entry.targetCats.length === 0,
    );
    if (dispatchTargetCatIds.length === 0 && !hasBroadcastEntry) return null;
    return computeQueueWaitInfo(activeInvocations, dispatchTargetCatIds);
  }, [activeInvocations, visibleEntries]);
  const canRecoverOrphanedQueue =
    !queuePaused && visibleEntries.some((entry) => queueEntryNeedsRecovery(entry, activeInvocationIds, activeCatIds));
  const activeInvocationIdByCatId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(activeInvocations ?? {}).map(([invocationId, invocation]) => [invocation.catId, invocationId]),
      ),
    [activeInvocations],
  );
  const activeCarrierCapabilityByCatId = useMemo(
    () =>
      Object.fromEntries(
        Object.values(activeInvocations).map((invocation) => [
          invocation.catId,
          catInvocations[invocation.catId]?.freshnessCarrierCapability,
        ]),
      ) as Readonly<Record<string, FreshnessCarrierCapability | undefined>>,
    [activeInvocations, catInvocations],
  );

  const handleRemove = useCallback(
    async (entryId: string) => {
      const prevQueue = queue;
      setQueue(
        threadId,
        prevQueue.filter((e) => e.id !== entryId),
      );
      try {
        const res = await apiFetch(`/api/threads/${threadId}/queue/${entryId}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setQueue(threadId, prevQueue);
          addToast({
            type: 'error',
            title: '停止失败',
            message: data?.error ?? '停止后续处理失败，请重试',
            threadId,
            duration: 5000,
          });
          return;
        }
        addToast({
          type: 'success',
          title: '已停止后续处理',
          message: '原消息与已经发生的读取事实仍保留在历史中',
          threadId,
          duration: 3000,
        });
      } catch {
        setQueue(threadId, prevQueue);
        addToast({
          type: 'error',
          title: '停止失败',
          message: '停止后续处理失败，请重试',
          threadId,
          duration: 5000,
        });
      }
    },
    [addToast, queue, setQueue, threadId],
  );

  const handleRecallEdit = useCallback(
    async (entryId: string) => {
      const entry = queue.find((e) => e.id === entryId);
      if (!entry) return;
      if (!entry.messageId) {
        addToast({
          type: 'error',
          title: '无法撤回这条消息',
          message: '缺少原消息身份；可以改用“停止后续处理”。',
          threadId,
          duration: 5000,
        });
        return;
      }

      try {
        const result = await requestTrueRecall({
          threadId,
          messageId: entry.messageId,
          confirmAppend: () => window.confirm('输入框已有草稿。撤回正文会空一行追加到当前草稿末尾，是否继续？'),
        });
        if (!result) return;
        setQueue(threadId, result.queue);
        const insert = composerInsertFromRecall(result);
        if (insert) setPendingChatInsert(insert);
        addToast({
          type: result.verdict === 'exposed' ? 'info' : 'success',
          title: result.verdict === 'exposed' ? '正文已撤回 · 猫曾读取' : '已撤回并回填输入框',
          message:
            result.verdict === 'exposed'
              ? '未读猫已停止后续处理；已读回合不会被普通撤回中断。'
              : '正文已从消息历史转移到持久草稿，可修改后重新发送。',
          threadId,
          duration: 4000,
        });
      } catch (error) {
        const conflict = error instanceof TrueRecallRequestError && error.code === 'DRAFT_REVISION_MISMATCH';
        addToast({
          type: 'error',
          title: conflict ? '草稿已在别处更新' : '撤回并重新编辑失败',
          message: conflict ? '原消息和两份草稿都没有改变；刷新输入框后再试。' : (error as Error).message,
          threadId,
          duration: 5000,
        });
      }
    },
    [addToast, queue, setPendingChatInsert, setQueue, threadId],
  );

  const handleContinue = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/threads/${threadId}/queue/next`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.started !== true) {
        addToast({
          type: 'error',
          title: '队列尚未恢复',
          message: '仍有运行占用，稍后重试或使用 Steer 立即接管这条消息。',
          threadId,
          duration: 5000,
        });
      }
    } catch {
      addToast({
        type: 'error',
        title: '队列恢复失败',
        message: '请求没有完成，请重试。',
        threadId,
        duration: 5000,
      });
    }
  }, [addToast, threadId]);

  const handleClear = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/threads/${threadId}/queue`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (Array.isArray(data?.queue)) setQueue(threadId, data.queue);
        addToast({
          type: 'error',
          title: data?.code === 'QUEUE_WITHDRAWAL_PARTIAL' ? '已停止部分消息' : '停止失败',
          message: data?.error ?? '停止后续处理失败，请重试',
          threadId,
          duration: 5000,
        });
        return;
      }
      addToast({
        type: 'success',
        title: '已全部停止后续处理',
        message: '原消息与已经发生的读取事实仍保留在历史中',
        threadId,
        duration: 3000,
      });
    } catch {
      addToast({
        type: 'error',
        title: '停止失败',
        message: '停止后续处理失败，请重试',
        threadId,
        duration: 5000,
      });
    }
  }, [addToast, setQueue, threadId]);

  const handleRemind = useCallback(
    async (entryId: string, targetCatId: string) => {
      const key = `${entryId}:${targetCatId}`;
      setRemindingTargetKeys((current) => new Set(current).add(key));
      try {
        const res = await apiFetch(`/api/threads/${threadId}/queue/${entryId}/remind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetCatId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const message =
            data?.code === 'NO_ACTIVE_INVOCATION'
              ? '这只猫当前没有可接收提醒的工作轮次。'
              : (data?.error ?? '提醒请求没有完成，请重试。');
          addToast({ type: 'error', title: '提醒未送达', message, threadId, duration: 5000 });
          return;
        }
        addToast({ ...reminderResultCopy(data?.state), threadId, duration: 3000 });
      } catch {
        addToast({
          type: 'error',
          title: '提醒未送达',
          message: '提醒请求没有完成，请重试。',
          threadId,
          duration: 5000,
        });
      } finally {
        setRemindingTargetKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [addToast, threadId],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = visibleEntries.findIndex((e) => e.id === active.id);
      const newIndex = visibleEntries.findIndex((e) => e.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(visibleEntries, oldIndex, newIndex);
      const positions = reordered.map((e, i) => ({ entryId: e.id, position: i }));

      const prevQueue = queue;
      setQueue(
        threadId,
        queue.map((e) => {
          const pos = positions.find((p) => p.entryId === e.id);
          return pos ? { ...e, position: pos.position } : e;
        }),
      );

      try {
        const res = await apiFetch(`/api/threads/${threadId}/queue/reorder`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ positions }),
        });
        if (!res.ok) {
          setQueue(threadId, prevQueue);
          addToast({ type: 'error', title: '排序失败', message: '排序失败，请重试', threadId, duration: 5000 });
        }
      } catch {
        setQueue(threadId, prevQueue);
        addToast({ type: 'error', title: '排序失败', message: '排序失败，请重试', threadId, duration: 5000 });
      }
    },
    [addToast, queue, setQueue, threadId, visibleEntries],
  );

  if (queue.length === 0) return null;
  if (visibleEntries.length === 0 && !queuePaused) return null;

  const isCollapsed = collapsed ?? visibleEntries.length >= COLLAPSE_THRESHOLD;
  const pauseLabel = queuePauseReason === 'canceled' ? '当前调用已取消' : '当前调用失败';
  const entryIds = visibleEntries.map((e) => e.id);

  const selectedSteerEntry = steerEntryId ? (queue.find((e) => e.id === steerEntryId) ?? null) : null;

  return (
    <div
      className={`border-t mx-4 mb-1 rounded-xl overflow-hidden ${
        queuePaused ? 'border-conn-amber-ring bg-conn-amber-bg/50' : ''
      }`}
      style={
        queuePaused
          ? undefined
          : {
              borderColor: 'color-mix(in oklch, var(--color-cocreator-primary) 20%, transparent)',
              backgroundColor: 'color-mix(in oklch, var(--color-cocreator-primary) 5%, transparent)',
            }
      }
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between px-3 py-2 ${queuePaused ? 'bg-conn-amber-bg/60' : ''}`}
        style={
          queuePaused
            ? undefined
            : { backgroundColor: 'color-mix(in oklch, var(--color-cocreator-primary) 10%, transparent)' }
        }
      >
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
            <path d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
          </svg>
          <span className="text-xs font-medium text-cafe-secondary">{queuePaused ? '队列已暂停' : '待处理'}</span>
          <span
            className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
              queuePaused
                ? 'bg-[var(--semantic-warning-surface)] text-conn-amber-text'
                : 'text-[var(--color-cocreator-primary)]'
            }`}
            style={
              queuePaused
                ? undefined
                : { backgroundColor: 'color-mix(in oklch, var(--color-cocreator-primary) 20%, transparent)' }
            }
          >
            {visibleEntries.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {(queuePaused || canRecoverOrphanedQueue) && (
            <button
              type="button"
              data-testid={canRecoverOrphanedQueue ? 'queue-recover' : undefined}
              onClick={handleContinue}
              className="text-xs px-2 py-1 rounded-md bg-[var(--semantic-success)] text-[var(--cafe-surface)] hover:opacity-90 transition-colors"
            >
              {queuePaused ? '继续' : '恢复'}
            </button>
          )}
          <button
            onClick={() => setCollapsed(!isCollapsed)}
            className="text-xs text-cafe-muted hover:text-cafe-secondary transition-colors"
          >
            {isCollapsed ? '展开' : '收起'}
          </button>
          <button
            type="button"
            onClick={handleClear}
            title="全部停止后续处理（保留原消息）"
            className="text-xs text-cafe-muted hover:text-conn-red-text transition-colors"
          >
            全部停止
          </button>
        </div>
      </div>

      {queuePaused && (
        <div className="px-3 py-1.5 text-xs text-conn-amber-text border-b border-conn-amber-ring/60">{pauseLabel}</div>
      )}

      {!queuePaused && waitInfo && visibleEntries.length > 0 && (
        <div
          className="px-3 py-1.5 text-xs text-cafe-muted border-b"
          style={{ borderColor: 'color-mix(in oklch, var(--color-cocreator-primary) 10%, transparent)' }}
        >
          {waitInfo.kind === 'active_turn' ? (
            <>
              等待 <span className="font-medium text-cafe-secondary">{resolveCatName(waitInfo.catId)}</span> 当前回合
              {waitInfo.elapsedLabel ? `（已运行 ${waitInfo.elapsedLabel}）` : ''}
            </>
          ) : (
            <>
              等待{' '}
              <span className="font-medium text-cafe-secondary">
                {waitInfo.catIds.map((catId) => resolveCatName(catId)).join('、')}
              </span>{' '}
              调度
            </>
          )}
        </div>
      )}

      {!isCollapsed && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={entryIds} strategy={verticalListSortingStrategy}>
            <div className="max-h-40 overflow-y-auto flex flex-col gap-0.5 p-1">
              {visibleEntries.map((entry, idx) => {
                // #706: Compute image count from server-enriched messagePreview
                const imageCount = entry.messagePreview?.contentBlocks?.filter((b) => b.type === 'image').length ?? 0;
                return (
                  <SortableQueueEntryRow
                    key={entry.id}
                    entry={entry}
                    index={idx}
                    isPaused={queuePaused}
                    imageCount={imageCount}
                    ownerName={coCreator.name}
                    resolveCatName={resolveCatName}
                    onRemove={handleRemove}
                    onRecallEdit={handleRecallEdit}
                    onSteer={handleSteerOpen}
                    onRetry={handleRetry}
                    onRemind={handleRemind}
                    activeInvocationIdByCatId={activeInvocationIdByCatId}
                    activeCarrierCapabilityByCatId={activeCarrierCapabilityByCatId}
                    remindingTargetKeys={remindingTargetKeys}
                    retryingAttemptIds={retryingAttemptIds}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {selectedSteerEntry && selectedSteerEntry.status === 'queued' && (
        <SteerQueuedEntryModal onCancel={handleSteerCancel} onConfirm={handleSteerConfirm} />
      )}
    </div>
  );
}
