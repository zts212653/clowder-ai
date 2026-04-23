'use client';

import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useCallback, useMemo, useState } from 'react';
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

interface QueuePanelProps {
  threadId: string;
}

export function QueuePanel({ threadId }: QueuePanelProps) {
  const coCreator = useCoCreatorConfig();
  const rawQueue = useChatStore((s) => s.queue);
  const queue = useMemo(() => rawQueue ?? [], [rawQueue]);
  const queuePaused = useChatStore((s) => s.queuePaused) ?? false;
  const queuePauseReason = useChatStore((s) => s.queuePauseReason);
  const messages = useChatStore((s) => s.messages);
  const setQueue = useChatStore((s) => s.setQueue);
  const addToast = useToastStore((s) => s.addToast);

  const [steerEntryId, setSteerEntryId] = useState<string | null>(null);
  const [steerMode, setSteerMode] = useState<SteerMode>('immediate');
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
            title: '撤回失败',
            message: data?.error ?? '撤回失败，请重试',
            threadId,
            duration: 5000,
          });
          return;
        }
        addToast({ type: 'success', title: '已取消', message: '已从队列撤回', threadId, duration: 2500 });
      } catch {
        setQueue(threadId, prevQueue);
        addToast({ type: 'error', title: '撤回失败', message: '撤回失败，请重试', threadId, duration: 5000 });
      }
    },
    [addToast, queue, setQueue, threadId],
  );

  const handleContinue = useCallback(async () => {
    await apiFetch(`/api/threads/${threadId}/queue/next`, { method: 'POST' });
  }, [threadId]);

  const handleClear = useCallback(async () => {
    await apiFetch(`/api/threads/${threadId}/queue`, { method: 'DELETE' });
  }, [threadId]);

  const handleSteerOpen = useCallback((entryId: string) => {
    setSteerMode('immediate');
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
        queuePaused ? 'border-amber-200 bg-amber-50/50' : 'border-[#9B7EBD]/20 bg-[#9B7EBD]/5'
      }`}
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between px-3 py-2 ${queuePaused ? 'bg-amber-100/60' : 'bg-[#9B7EBD]/10'}`}
      >
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
            <path d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
          </svg>
          <span className="text-xs font-medium text-cafe-secondary">{queuePaused ? '队列已暂停' : '排队中'}</span>
          <span
            className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
              queuePaused ? 'bg-amber-200 text-amber-700' : 'bg-[#9B7EBD]/20 text-[#9B7EBD]'
            }`}
          >
            {visibleEntries.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {queuePaused && (
            <button
              onClick={handleContinue}
              className="text-xs px-2 py-1 rounded-md bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
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
          <button onClick={handleClear} className="text-xs text-cafe-muted hover:text-red-500 transition-colors">
            清空
          </button>
        </div>
      </div>

      {queuePaused && (
        <div className="px-3 py-1.5 text-xs text-amber-600 border-b border-amber-200/60">{pauseLabel}</div>
      )}

      {!isCollapsed && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={entryIds} strategy={verticalListSortingStrategy}>
            <div className="max-h-40 overflow-y-auto">
              {visibleEntries.map((entry, idx) => {
                const allMsgIds = [entry.messageId, ...(entry.mergedMessageIds ?? [])].filter(Boolean) as string[];
                const imageCount = allMsgIds.reduce((count, msgId) => {
                  const msg = messages.find((m) => m.id === msgId);
                  return count + (msg?.contentBlocks?.filter((b) => b.type === 'image').length ?? 0);
                }, 0);
                return (
                  <SortableQueueEntryRow
                    key={entry.id}
                    entry={entry}
                    index={idx}
                    isPaused={queuePaused}
                    imageCount={imageCount}
                    ownerName={coCreator.name}
                    onRemove={handleRemove}
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
