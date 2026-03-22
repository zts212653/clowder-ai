'use client';

import { useCallback, useMemo } from 'react';
import type { UploadStatus, WhisperOptions } from '@/hooks/useSendMessage';
import type { DeliveryMode } from '@/stores/chat-types';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { ChatInput } from './ChatInput';
import { PawIcon } from './icons/PawIcon';
import { MiniThreadSidebar } from './MiniThreadSidebar';
import { SplitPaneCell, SplitPanePlaceholder } from './SplitPaneCell';

interface SplitPaneViewProps {
  onSend: (
    content: string,
    images?: File[],
    overrideThreadId?: string,
    whisper?: WhisperOptions,
    deliveryMode?: DeliveryMode,
  ) => void;
  onStop: (overrideThreadId?: string) => void;
  uploadStatus?: UploadStatus;
  uploadError?: string | null;
  /** Switch from split to single mode, focusing the given thread */
  onZoomToThread: (threadId: string) => void;
}

const PANE_COUNT = 4;

/**
 * Split-pane mode: 2x2 grid of mini chat views + mini sidebar + shared input.
 * The shared input bar sends to the currently selected pane (splitPaneTargetId).
 */
export function SplitPaneView({ onSend, onStop, uploadStatus, uploadError, onZoomToThread }: SplitPaneViewProps) {
  const { threads, splitPaneThreadIds, splitPaneTargetId, setSplitPaneTarget, setSplitPaneThreadIds, getThreadState } =
    useChatStore();

  const threadMap = new Map<string, Thread>();
  for (const t of threads) threadMap.set(t.id, t);

  // Ensure we always have exactly PANE_COUNT slots (pad with empty)
  const paneSlots = useMemo(() => {
    const slots: (string | null)[] = [];
    for (let i = 0; i < PANE_COUNT; i++) {
      slots.push(splitPaneThreadIds[i] ?? null);
    }
    return slots;
  }, [splitPaneThreadIds]);

  const handleSelectPane = useCallback((threadId: string) => setSplitPaneTarget(threadId), [setSplitPaneTarget]);

  const handleDoubleClick = useCallback((threadId: string) => onZoomToThread(threadId), [onZoomToThread]);

  /** Assign a thread from the mini sidebar to the next empty pane (or replace selected if full) */
  const handleAssignToPane = useCallback(
    (threadId: string) => {
      if (splitPaneThreadIds.includes(threadId)) return; // already in a pane
      const next = [...splitPaneThreadIds];
      const emptyIdx = paneSlots.indexOf(null);
      if (emptyIdx >= 0) {
        // Fill the first empty slot
        while (next.length <= emptyIdx) next.push('');
        next[emptyIdx] = threadId;
      } else {
        // All panes full — replace the currently selected pane
        const selectedIdx = splitPaneTargetId ? paneSlots.indexOf(splitPaneTargetId) : 0;
        const idx = selectedIdx >= 0 ? selectedIdx : 0;
        next[idx] = threadId;
      }
      setSplitPaneThreadIds(next.filter(Boolean));
      setSplitPaneTarget(threadId);
    },
    [splitPaneThreadIds, splitPaneTargetId, paneSlots, setSplitPaneThreadIds, setSplitPaneTarget],
  );

  const targetThreadState = splitPaneTargetId ? getThreadState(splitPaneTargetId) : null;
  const isTargetActiveInvocation = targetThreadState?.hasActiveInvocation ?? false;

  const handleBackToSingle = useCallback(() => {
    const target = splitPaneTargetId ?? splitPaneThreadIds[0];
    if (target) {
      onZoomToThread(target);
    } else {
      useChatStore.getState().setViewMode('single');
    }
  }, [splitPaneTargetId, splitPaneThreadIds, onZoomToThread]);

  return (
    <div className="flex flex-col h-screen h-dvh">
      {/* Toolbar — matches single-mode header style */}
      <header className="border-b border-cocreator-light px-5 py-3 bg-cocreator-bg flex items-center gap-2 flex-shrink-0">
        <PawIcon className="w-6 h-6 text-cocreator-primary" />
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-cafe-black">Clowder AI</h1>
          <p className="text-xs text-gray-500">分屏模式</p>
        </div>
        <span className="text-[10px] text-gray-400 hidden sm:inline mr-1">⌘\ 切换</span>
        <button
          onClick={handleBackToSingle}
          className="p-1 rounded-lg hover:bg-cocreator-light transition-colors"
          aria-label="切换单屏模式"
          title="返回单屏"
        >
          <svg className="w-5 h-5 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
            <rect x="2" y="2" width="16" height="16" rx="2" />
          </svg>
        </button>
      </header>

      <div className="flex flex-1 min-h-0">
        <MiniThreadSidebar onAssignToPane={handleAssignToPane} />

        <div className="flex flex-col flex-1 min-w-0">
          {/* 2x2 grid */}
          <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-2 p-2 min-h-0">
            {paneSlots.map((tid, i) => {
              if (!tid) {
                return <SplitPanePlaceholder key={`empty-${i}`} index={i} />;
              }
              const thread = threadMap.get(tid);
              return (
                <SplitPaneCell
                  key={tid}
                  threadId={tid}
                  threadTitle={thread?.title ?? '未命名对话'}
                  threadState={getThreadState(tid)}
                  isSelected={splitPaneTargetId === tid}
                  onSelect={handleSelectPane}
                  onDoubleClick={handleDoubleClick}
                />
              );
            })}
          </div>

          {/* Shared input bar */}
          <div className="border-t border-cocreator-light bg-white px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] text-gray-400">
                {splitPaneTargetId
                  ? `发往: ${threadMap.get(splitPaneTargetId)?.title ?? splitPaneTargetId}`
                  : '请选择一个窗格'}
              </span>
            </div>
            <ChatInput
              key={splitPaneTargetId ?? 'no-target'}
              threadId={splitPaneTargetId ?? undefined}
              onSend={(content, images, whisper, deliveryMode) =>
                onSend(content, images, splitPaneTargetId ?? undefined, whisper, deliveryMode)
              }
              onStop={() => onStop(splitPaneTargetId ?? undefined)}
              disabled={!splitPaneTargetId}
              hasActiveInvocation={isTargetActiveInvocation}
              uploadStatus={uploadStatus}
              uploadError={uploadError}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
