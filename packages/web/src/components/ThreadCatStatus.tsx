'use client';

import type { CatStatusType, ThreadState } from '@/stores/chat-types';
import { PawIcon } from './icons/PawIcon';

/**
 * ASCII cat status indicator for thread sidebar.
 * Shows ᓚᘏᗢ with CSS animation + color based on aggregate thread state.
 */

function aggregateStatus(ts: ThreadState): 'idle' | 'working' | 'done' | 'error' {
  const statuses = Object.values(ts.catStatuses);
  if (statuses.length === 0) return 'idle';
  if (statuses.some((s) => s === 'error')) return 'error';
  if (statuses.some((s) => s === 'streaming' || s === 'pending' || s === 'spawning')) return 'working';
  if (statuses.some((s) => s === 'done')) return 'done';
  return 'idle';
}

export function ThreadCatStatus({
  threadState,
  unreadCount,
  hasUserMention,
}: {
  threadState: ThreadState;
  unreadCount: number;
  hasUserMention?: boolean;
}) {
  const status = aggregateStatus(threadState);

  if (status === 'idle' && unreadCount === 0 && !hasUserMention) return null;

  const statusClasses: Record<string, string> = {
    idle: 'text-cafe-muted',
    working: 'text-amber-500 animate-cat-bounce',
    done: 'text-green-500',
    error: 'text-red-500 animate-cat-shake',
  };

  return (
    <span className="inline-flex items-center gap-0.5 flex-shrink-0">
      {status !== 'idle' && (
        <span className={`text-xs ${statusClasses[status]}`} title={status}>
          ᓚᘏᗢ
        </span>
      )}
      {status === 'done' && <span className="text-green-500 text-[10px]">&#10003;</span>}
      {hasUserMention && (
        <span title="猫猫 @ 了你">
          <PawIcon className="h-3 w-3 text-cafe-secondary" />
        </span>
      )}
      {unreadCount > 0 && (
        <span
          className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-white text-[10px] font-bold leading-none ${
            hasUserMention ? 'bg-red-500' : 'bg-amber-500'
          }`}
        >
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </span>
  );
}

/** Aggregate cat status for a given set of catStatuses */
export function getCatStatusType(catStatuses: Record<string, CatStatusType>): 'idle' | 'working' | 'done' | 'error' {
  const statuses = Object.values(catStatuses);
  if (statuses.length === 0) return 'idle';
  if (statuses.some((s) => s === 'error')) return 'error';
  if (statuses.some((s) => s === 'streaming' || s === 'pending' || s === 'spawning')) return 'working';
  if (statuses.some((s) => s === 'done')) return 'done';
  return 'idle';
}
