'use client';

import { useCallback, useMemo, useState } from 'react';
import { type QueueEntry, useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { type SteerMode, SteerQueuedEntryModal } from './SteerQueuedEntryModal';

interface QueuePanelProps {
  threadId: string;
}

/**
 * F39: Queue management panel — displayed between messages and ChatInput
 * when there are queued messages. Shows queue entries with reorder/withdraw
 * controls, plus continue/clear actions when paused.
 */
export function QueuePanel({ threadId }: QueuePanelProps) {
  const queue = useChatStore((s) => s.queue) ?? [];
  const queuePaused = useChatStore((s) => s.queuePaused) ?? false;
  const queuePauseReason = useChatStore((s) => s.queuePauseReason);
  const messages = useChatStore((s) => s.messages);
  const setQueue = useChatStore((s) => s.setQueue);
  const addToast = useToastStore((s) => s.addToast);

  const [steerEntryId, setSteerEntryId] = useState<string | null>(null);
  const [steerMode, setSteerMode] = useState<SteerMode>('immediate');

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
          const msg = data?.error ?? '撤回失败，请重试';
          setQueue(threadId, prevQueue);
          addToast({
            type: 'error',
            title: '撤回失败',
            message: msg,
            threadId,
            duration: 5000,
          });
          return;
        }
        addToast({
          type: 'success',
          title: '已取消',
          message: '已从队列撤回',
          threadId,
          duration: 2500,
        });
      } catch {
        setQueue(threadId, prevQueue);
        addToast({
          type: 'error',
          title: '撤回失败',
          message: '撤回失败，请重试',
          threadId,
          duration: 5000,
        });
      }
    },
    [addToast, queue, setQueue, threadId],
  );

  const handleMove = useCallback(
    async (entryId: string, direction: 'up' | 'down') => {
      await apiFetch(`/api/threads/${threadId}/queue/${entryId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
    },
    [threadId],
  );

  const handleContinue = useCallback(async () => {
    await apiFetch(`/api/threads/${threadId}/queue/next`, { method: 'POST' });
  }, [threadId]);

  const handleClear = useCallback(async () => {
    await apiFetch(`/api/threads/${threadId}/queue`, { method: 'DELETE' });
  }, [threadId]);

  const selectedSteerEntry = useMemo(
    () => (steerEntryId ? (queue.find((e) => e.id === steerEntryId) ?? null) : null),
    [queue, steerEntryId],
  );

  const handleSteerOpen = useCallback((entryId: string) => {
    setSteerMode('immediate');
    setSteerEntryId(entryId);
  }, []);

  const handleSteerCancel = useCallback(() => {
    setSteerEntryId(null);
  }, []);

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
        addToast({
          type: 'error',
          title: 'Steer 失败',
          message: msg,
          threadId,
          duration: 5000,
        });
        return;
      }
      setSteerEntryId(null);
    } catch {
      addToast({
        type: 'error',
        title: 'Steer 失败',
        message: 'Steer 失败，请重试',
        threadId,
        duration: 5000,
      });
    }
  }, [addToast, steerEntryId, steerMode, threadId]);

  // Don't render when queue is empty
  if (queue.length === 0) return null;

  // User-facing entries: show queued entries (processing steer is out-of-scope for F047)
  const visibleEntries = queue.filter((e) => e.status === 'queued');
  if (visibleEntries.length === 0 && !queuePaused) return null;

  const pauseLabel = queuePauseReason === 'canceled' ? '当前调用已取消' : '当前调用失败';

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
          <svg className="w-4 h-4 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
            <path d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
          </svg>
          <span className="text-xs font-medium text-gray-600">{queuePaused ? '队列已暂停' : '排队中'}</span>
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
          <button onClick={handleClear} className="text-xs text-gray-400 hover:text-red-500 transition-colors">
            清空
          </button>
        </div>
      </div>

      {/* Pause reason */}
      {queuePaused && (
        <div className="px-3 py-1.5 text-xs text-amber-600 border-b border-amber-200/60">{pauseLabel}</div>
      )}

      {/* Queue entries */}
      <div className="max-h-40 overflow-y-auto">
        {visibleEntries.map((entry, idx) => {
          // Count images from primary + merged messages (Cloud R2 P2)
          const allMsgIds = [entry.messageId, ...entry.mergedMessageIds].filter(Boolean) as string[];
          const imageCount = allMsgIds.reduce((count, msgId) => {
            const msg = messages.find((m) => m.id === msgId);
            return count + (msg?.contentBlocks?.filter((b) => b.type === 'image').length ?? 0);
          }, 0);
          return (
            <QueueEntryRow
              key={entry.id}
              entry={entry}
              index={idx}
              isFirst={idx === 0}
              isLast={idx === visibleEntries.length - 1}
              isPaused={queuePaused}
              imageCount={imageCount}
              onRemove={handleRemove}
              onMove={handleMove}
              onSteer={handleSteerOpen}
            />
          );
        })}
      </div>

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

/** Single queue entry row with reorder/remove controls */
function QueueEntryRow({
  entry,
  index,
  isFirst,
  isLast,
  isPaused,
  imageCount,
  onRemove,
  onMove,
  onSteer,
}: {
  entry: QueueEntry;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  isPaused: boolean;
  imageCount: number;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onSteer: (id: string) => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 border-b last:border-b-0 ${
        isPaused ? 'border-amber-100' : 'border-[#9B7EBD]/10'
      }`}
    >
      {/* Number */}
      <span className="text-xs text-gray-400 w-5 text-center shrink-0">{index + 1}</span>

      {/* Content preview */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-700 truncate">{entry.content}</p>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#9B7EBD]" />
          <span className="text-xs text-gray-400">{entry.source === 'connector' ? 'Connector' : 'team lead'}</span>
          {imageCount > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-gray-400 ml-1">
              <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z"
                  clipRule="evenodd"
                />
              </svg>
              {imageCount}
            </span>
          )}
        </div>
      </div>

      {/* Reorder buttons */}
      <div className="flex flex-col gap-0.5 shrink-0">
        {!isFirst && (
          <button
            onClick={() => onMove(entry.id, 'up')}
            className="p-0.5 text-gray-400 hover:text-gray-600 transition-colors"
            title="Move up"
            aria-label="Move up"
          >
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        )}
        {!isLast && (
          <button
            onClick={() => onMove(entry.id, 'down')}
            className="p-0.5 text-gray-400 hover:text-gray-600 transition-colors"
            title="Move down"
            aria-label="Move down"
          >
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Steer button (F047) */}
      <button
        type="button"
        data-testid={`steer-${entry.id}`}
        onClick={() => onSteer(entry.id)}
        className="text-xs px-3 py-1 rounded-full bg-[#9B7EBD] text-white hover:bg-[#8B6FAE] transition-colors shrink-0"
        aria-label="Steer"
      >
        Steer
      </button>

      {/* Remove button */}
      <button
        onClick={() => onRemove(entry.id)}
        className="p-1 text-gray-400 hover:text-red-500 transition-colors shrink-0"
        title="Remove"
        aria-label="撤回"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}
