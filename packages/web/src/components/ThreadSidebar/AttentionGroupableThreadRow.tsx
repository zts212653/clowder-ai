'use client';

import { type ReactNode, useCallback, useEffect, useRef } from 'react';

interface AttentionGroupableThreadRowProps {
  threadId: string;
  threadTitle: string | null;
  groupable: boolean;
  arrangeMode: boolean;
  draggedThreadId: string | null;
  onEnterArrange: () => void;
  onDragStartThread: (threadId: string) => void;
  onDragEndThread: () => void;
  getDraggedThreadId: () => string | null;
  onDropThread: (sourceThreadId: string, targetThreadId: string) => void;
  children: ReactNode;
}

/** Shared production gesture surface for pointer, keyboard, and drag conversation grouping. */
export function AttentionGroupableThreadRow({
  threadId,
  threadTitle,
  groupable,
  arrangeMode,
  draggedThreadId,
  onEnterArrange,
  onDragStartThread,
  onDragEndThread,
  getDraggedThreadId,
  onDropThread,
  children,
}: AttentionGroupableThreadRowProps) {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    longPressStartRef.current = null;
  }, []);

  useEffect(() => cancelLongPress, [cancelLongPress]);

  return (
    <div
      role="group"
      aria-label={`整理对话：${threadTitle || '未命名对话'}`}
      draggable={groupable}
      data-attention-draggable-thread={groupable ? threadId : undefined}
      data-attention-arranging={arrangeMode || undefined}
      data-attention-dragging={draggedThreadId === threadId || undefined}
      onPointerDown={(event) => {
        if (!groupable || event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest('button, input, textarea, select, [role="menu"]')) {
          return;
        }
        cancelLongPress();
        longPressStartRef.current = { x: event.clientX, y: event.clientY };
        longPressTimerRef.current = window.setTimeout(() => {
          suppressClickRef.current = true;
          onEnterArrange();
          longPressTimerRef.current = null;
        }, 450);
      }}
      onPointerMove={(event) => {
        const start = longPressStartRef.current;
        if (!start || longPressTimerRef.current === null) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) cancelLongPress();
      }}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onClickCapture={(event) => {
        if (!arrangeMode && !suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
      }}
      onKeyDownCapture={(event) => {
        if (!arrangeMode || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onDragStart={(event) => {
        if (!groupable) {
          event.preventDefault();
          return;
        }
        onEnterArrange();
        onDragStartThread(threadId);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', threadId);
        }
      }}
      onDragEnd={onDragEndThread}
      onDragOver={(event) => {
        if (!draggedThreadId || draggedThreadId === threadId) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        event.preventDefault();
        const sourceThreadId =
          draggedThreadId || event.dataTransfer?.getData('text/plain') || getDraggedThreadId() || null;
        if (sourceThreadId) onDropThread(sourceThreadId, threadId);
        onDragEndThread();
      }}
      className={
        arrangeMode && groupable ? 'motion-safe:animate-[f277-jiggle_180ms_ease-in-out_infinite_alternate]' : undefined
      }
    >
      {children}
    </div>
  );
}
