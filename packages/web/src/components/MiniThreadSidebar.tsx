'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatStatusType } from '@/stores/chat-types';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { CatAvatar } from './CatAvatar';
import { getCatStatusType } from './ThreadCatStatus';

interface MiniThreadSidebarProps {
  onAssignToPane: (threadId: string) => void;
}

const MIN_WIDTH = 40;
const DEFAULT_WIDTH = 160;
const MAX_WIDTH = 300;

/**
 * Resizable sidebar for split-pane mode.
 * Shows thread icons + names. Drag right edge to resize.
 * Click a thread to assign it to the currently selected pane.
 */
export function MiniThreadSidebar({ onAssignToPane }: MiniThreadSidebarProps) {
  const { threads, splitPaneThreadIds, getThreadState } = useChatStore();
  const assignedSet = new Set(splitPaneThreadIds);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragging = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Unmount safety net: remove any lingering document listeners
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const available = threads.filter((t) => t.id !== 'default' && !assignedSet.has(t.id));
  const assigned = threads.filter((t) => assignedSet.has(t.id));
  const isCollapsed = width < 80;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startX = e.clientX;
      const startWidth = width;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = ev.clientX - startX;
        setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta)));
      };
      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        cleanupRef.current = null;
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      cleanupRef.current = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
    },
    [width],
  );

  return (
    <aside
      className="relative flex h-full flex-shrink-0 flex-col border-r border-[var(--console-border-soft)] bg-[var(--console-panel-bg)]"
      style={{ width }}
    >
      <div className="flex-1 overflow-y-auto py-2 px-1 space-y-0.5">
        {assigned.length > 0 && (
          <div className="px-1 mb-1">
            <span className="text-[9px] text-cafe-muted uppercase tracking-wider">{isCollapsed ? '' : '窗格中'}</span>
          </div>
        )}
        {assigned.map((t) => (
          <MiniThreadRow key={t.id} thread={t} isInPane isCollapsed={isCollapsed} getThreadState={getThreadState} />
        ))}

        {assigned.length > 0 && available.length > 0 && (
          <div className="mx-1 border-t border-[var(--console-border-soft)] my-1.5" />
        )}

        {available.length > 0 && (
          <div className="px-1 mb-1">
            <span className="text-[9px] text-cafe-muted uppercase tracking-wider">{isCollapsed ? '' : '可添加'}</span>
          </div>
        )}
        {available.map((t) => (
          <MiniThreadRow
            key={t.id}
            thread={t}
            isCollapsed={isCollapsed}
            getThreadState={getThreadState}
            onClick={() => onAssignToPane(t.id)}
          />
        ))}
      </div>

      {/* Drag handle */}
      <div
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize transition-colors hover:bg-[var(--console-hover-bg)] active:bg-cafe-accent/20"
        onMouseDown={handleMouseDown}
      />
    </aside>
  );
}

function MiniThreadRow({
  thread,
  isInPane,
  isCollapsed,
  getThreadState,
  onClick,
}: {
  thread: Thread;
  isInPane?: boolean;
  isCollapsed: boolean;
  getThreadState: (id: string) => {
    catStatuses: Record<string, CatStatusType>;
    unreadCount: number;
    hasUserMention: boolean;
  };
  onClick?: () => void;
}) {
  const ts = getThreadState(thread.id);
  const status = getCatStatusType(ts.catStatuses);
  const dotColor =
    status === 'error'
      ? 'bg-conn-red-bg'
      : status === 'working'
        ? 'bg-conn-amber-bg animate-pulse'
        : status === 'done'
          ? 'bg-conn-emerald-bg'
          : '';

  const firstCat = thread.participants[0];
  const title = thread.title ?? thread.id;

  return (
    <button
      onClick={onClick}
      className={`relative w-full flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors ${
        isInPane ? 'bg-[var(--console-active-bg)]' : 'hover:bg-[var(--console-hover-bg)]'
      } ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
      title={title}
    >
      <div className="relative flex-shrink-0 w-6 h-6 flex items-center justify-center">
        {firstCat ? (
          <CatAvatar catId={firstCat} size={20} />
        ) : (
          <span className="text-xs font-medium text-cafe-secondary">{title.charAt(0).toUpperCase()}</span>
        )}
        {dotColor && <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${dotColor}`} />}
      </div>
      {!isCollapsed && <span className="text-xs text-cafe-secondary truncate flex-1 min-w-0">{title}</span>}
      {ts.unreadCount > 0 && (
        <span
          className={`text-[8px] ${ts.hasUserMention ? 'bg-conn-red-text' : 'bg-conn-amber-text'} text-[var(--cafe-surface)] rounded-full min-w-[14px] px-0.5 text-center leading-3 flex-shrink-0`}
        >
          {ts.unreadCount > 9 ? '9+' : ts.unreadCount}
        </span>
      )}
    </button>
  );
}
