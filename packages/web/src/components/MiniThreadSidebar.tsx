'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { type SidebarSnapshotRow, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { CatAvatar } from './CatAvatar';

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
  const { threads, splitPaneThreadIds } = useChatStore(
    useShallow((s) => ({
      threads: s.threads,
      splitPaneThreadIds: s.splitPaneThreadIds,
    })),
  );
  // PR-3a: status dots and unread badges read the F297 canonical snapshot, like the main Sidebar.
  // Local per-thread state is fed by thread rooms, which background threads will stop joining.
  const sidebarRows = useSidebarProjectionStore((s) => s.rows);
  const rowById = new Map(sidebarRows.map((row) => [row.id, row]));
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
      className="relative flex-shrink-0 border-r border-cafe-subtle bg-cafe-surface flex flex-col h-full"
      style={{ width }}
    >
      <div className="flex-1 overflow-y-auto py-2 px-1 space-y-0.5">
        {assigned.length > 0 && (
          <div className="px-1 mb-1">
            <span className="text-micro text-cafe-muted uppercase tracking-wider">{isCollapsed ? '' : '窗格中'}</span>
          </div>
        )}
        {assigned.map((t) => (
          <MiniThreadRow key={t.id} thread={t} isInPane isCollapsed={isCollapsed} row={rowById.get(t.id)} />
        ))}

        {assigned.length > 0 && available.length > 0 && <div className="mx-1 border-t border-cafe my-1.5" />}

        {available.length > 0 && (
          <div className="px-1 mb-1">
            <span className="text-micro text-cafe-muted uppercase tracking-wider">{isCollapsed ? '' : '可添加'}</span>
          </div>
        )}
        {available.map((t) => (
          <MiniThreadRow
            key={t.id}
            thread={t}
            isCollapsed={isCollapsed}
            row={rowById.get(t.id)}
            onClick={() => onAssignToPane(t.id)}
          />
        ))}
      </div>

      {/* Drag handle */}
      <div
        className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-cafe-accent/20 active:bg-cafe-accent/30 transition-colors"
        onMouseDown={handleMouseDown}
      />
    </aside>
  );
}

function MiniThreadRow({
  thread,
  isInPane,
  isCollapsed,
  row,
  onClick,
}: {
  thread: Thread;
  isInPane?: boolean;
  isCollapsed: boolean;
  /** Absent until the canonical snapshot has this thread: shown idle with no badge. */
  row: SidebarSnapshotRow | undefined;
  onClick?: () => void;
}) {
  const status = row?.presence.status ?? 'idle';
  const unreadCount = row?.unreadCount ?? 0;
  const hasUserMention = row?.hasUserMention ?? false;
  const dotColor =
    status === 'error'
      ? 'bg-[var(--semantic-critical)]'
      : status === 'working'
        ? 'bg-[var(--semantic-warning)] animate-pulse'
        : status === 'done'
          ? 'bg-[var(--semantic-success)]'
          : '';

  const firstCat = thread.participants[0];
  const title = thread.title ?? thread.id;

  return (
    <button
      onClick={onClick}
      className={`relative w-full flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors ${
        isInPane ? 'bg-cafe-surface-sunken' : 'hover:bg-cafe-surface-elevated'
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
      {unreadCount > 0 && (
        <span
          className={`text-micro ${hasUserMention ? 'bg-conn-red-text' : 'bg-[var(--semantic-warning)]'} text-[var(--cafe-surface)] rounded-full min-w-[14px] px-0.5 text-center leading-3 flex-shrink-0`}
        >
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
    </button>
  );
}
