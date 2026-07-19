'use client';

import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useCallback, useMemo, useState } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { SortableQueueEntryRow } from './QueueEntryRow';
import { type SteerMode, SteerQueuedEntryModal } from './SteerQueuedEntryModal';

const COLLAPSE_THRESHOLD = 4;

const PRIORITY_RANK: Record<string, number> = { urgent: 0, normal: 1 };

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

/**
 * A2A queue visibility (2026-06-02): derive what the queue is waiting behind from the live
 * activeInvocations map. Returns null when nothing is active (queue is draining, not blocked).
 *
 * Per-cat slot semantics (QueueProcessor uses a `threadId:catId` slot mutex): a queued entry
 * waits on ITS target cat's slot, NOT just any active turn. So we PREFER the oldest active
 * invocation whose catId a visible queued entry actually targets — this avoids the 砚砚-P1 bug
 * where a longer-running non-target cat (e.g. codex) would be shown as the blocker when the
 * visible queued entry is really waiting on a different cat (e.g. opus). Only when NO target
 * cat is active do we fall back to the oldest active turn (thread-level block, e.g. a
 * broadcast entry queued because the thread is busy) — that fallback can never misattribute a
 * target-cat blocker, since by definition no target cat is active in that branch.
 *
 * Pure: `now` injected for testing.
 */
export function computeQueueWaitInfo(
  activeInvocations: Record<string, { catId: string; mode?: string; startedAt?: number }> | undefined,
  queuedTargetCatIds: Iterable<string> = [],
  now: number = Date.now(),
): { catId: string; elapsedLabel: string | null } | null {
  const slots = Object.values(activeInvocations ?? {});
  if (slots.length === 0) return null;
  const targets = new Set(queuedTargetCatIds);
  const targeted = targets.size > 0 ? slots.filter((s) => targets.has(s.catId)) : [];
  const candidates = targeted.length > 0 ? targeted : slots;
  let oldest = candidates[0];
  for (const s of candidates) {
    if ((s.startedAt ?? Number.POSITIVE_INFINITY) < (oldest.startedAt ?? Number.POSITIVE_INFINITY)) oldest = s;
  }
  return {
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
  const activeInvocations = useChatStore((s) => s.activeInvocations);
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const addToast = useToastStore((s) => s.addToast);

  const [steerEntryId, setSteerEntryId] = useState<string | null>(null);
  const [steerMode, setSteerMode] = useState<SteerMode>('promote');
  const [collapsed, setCollapsed] = useState<boolean | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const visibleEntries = useMemo(
    () =>
      queue
        .filter(
          (e) => e.status === 'queued' && !(e.source === 'connector' && e.content.startsWith(SCHEDULER_TRIGGER_PREFIX)),
        )
        .sort(compareQueueEntries),
    [queue],
  );

  // A2A queue visibility: explain WHY entries are queued (waiting behind the active turn) so the
  // user can tell "waiting for the current turn" apart from "stuck". Passes the visible queued
  // entries' target cats so the wait reason attributes the RIGHT cat (per-cat slot), not just the
  // oldest active turn. Recomputed when activeInvocations/visibleEntries change; elapsed reflects
  // the last store update (acceptable for v1 — no per-second tick).
  const waitInfo = useMemo(
    () =>
      computeQueueWaitInfo(
        activeInvocations,
        visibleEntries.flatMap((e) => e.targetCats),
      ),
    [activeInvocations, visibleEntries],
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
            title: '删除失败',
            message: data?.error ?? '删除失败，请重试',
            threadId,
            duration: 5000,
          });
          return;
        }
        addToast({ type: 'success', title: '已删除', message: '已从队列删除', threadId, duration: 2500 });
      } catch {
        setQueue(threadId, prevQueue);
        addToast({ type: 'error', title: '删除失败', message: '删除失败，请重试', threadId, duration: 5000 });
      }
    },
    [addToast, queue, setQueue, threadId],
  );

  const handleRecallEdit = useCallback(
    async (entryId: string) => {
      const entry = queue.find((e) => e.id === entryId);
      if (!entry) return;

      // #706: Extract image URLs from server-enriched messagePreview (already in queue data).
      // No need to read from DELETE response — the data is available before the request.
      const imageUrls = (entry.messagePreview?.contentBlocks ?? [])
        .filter((b) => b.type === 'image' && b.url)
        .map((b) => b.url!);

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
            title: '撤回编辑失败',
            message: data?.error ?? '撤回编辑失败，请重试',
            threadId,
            duration: 5000,
          });
          return;
        }

        // #706 + #833 cross-PR: preserve replyToId so recall-edit restores quote state
        const replyToId = entry.messagePreview?.replyTo;
        setPendingChatInsert({
          threadId,
          text: entry.content,
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
          ...(replyToId ? { replyToId } : {}),
        });
        const hasImages = imageUrls.length > 0;
        const hasQuote = !!replyToId;
        const parts = ['已回填文字'];
        if (hasImages) parts.push('图片');
        if (hasQuote) parts.push('引用');
        addToast({
          type: 'success',
          title: '已撤回编辑',
          message: `${parts.join('、')}到输入框`,
          threadId,
          duration: 2500,
        });
      } catch {
        setQueue(threadId, prevQueue);
        addToast({ type: 'error', title: '撤回编辑失败', message: '撤回编辑失败，请重试', threadId, duration: 5000 });
      }
    },
    [addToast, queue, setPendingChatInsert, setQueue, threadId],
  );

  const handleContinue = useCallback(async () => {
    await apiFetch(`/api/threads/${threadId}/queue/next`, { method: 'POST' });
  }, [threadId]);

  const handleClear = useCallback(async () => {
    await apiFetch(`/api/threads/${threadId}/queue`, { method: 'DELETE' });
  }, [threadId]);

  const handleSteerOpen = useCallback((entryId: string) => {
    setSteerMode('promote');
    setSteerEntryId(entryId);
  }, []);

  const handleSteerCancel = useCallback(() => setSteerEntryId(null), []);

  const handleSteerConfirm = useCallback(async () => {
    if (!steerEntryId) return;
    try {
      const res = await apiFetch(`/api/threads/${threadId}/queue/${steerEntryId}/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: steerMode }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg =
          data?.code === 'ENTRY_PROCESSING' ? '该消息正在处理，无法 steer' : (data?.error ?? 'Steer 失败，请重试');
        addToast({ type: 'error', title: 'Steer 失败', message: msg, threadId, duration: 5000 });
        return;
      }
      setSteerEntryId(null);
    } catch {
      addToast({ type: 'error', title: 'Steer 失败', message: 'Steer 失败，请重试', threadId, duration: 5000 });
    }
  }, [addToast, steerEntryId, steerMode, threadId]);

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
          <span className="text-xs font-medium text-cafe-secondary">{queuePaused ? '队列已暂停' : '排队中'}</span>
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
          {queuePaused && (
            <button
              onClick={handleContinue}
              className="text-xs px-2 py-1 rounded-md bg-[var(--semantic-success)] text-[var(--cafe-surface)] hover:opacity-90 transition-colors"
            >
              继续
            </button>
          )}
          <button
            onClick={() => setCollapsed(!isCollapsed)}
            className="text-xs text-cafe-muted hover:text-cafe-secondary transition-colors"
          >
            {isCollapsed ? '展开' : '收起'}
          </button>
          <button onClick={handleClear} className="text-xs text-cafe-muted hover:text-conn-red-text transition-colors">
            清空
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
          等待 <span className="font-medium text-cafe-secondary">{resolveCatName(waitInfo.catId)}</span> 当前回合
          {waitInfo.elapsedLabel ? `（已运行 ${waitInfo.elapsedLabel}）` : ''}
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
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {selectedSteerEntry && selectedSteerEntry.status === 'queued' && (
        <SteerQueuedEntryModal
          mode={steerMode}
          onModeChange={setSteerMode}
          onCancel={handleSteerCancel}
          onConfirm={handleSteerConfirm}
        />
      )}
    </div>
  );
}
