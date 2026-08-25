'use client';

import type { CatStatusType } from '@/stores/chat-types';
import type { SidebarPresence } from '@/stores/sidebarProjectionStore';
import { PawIcon } from './icons/PawIcon';

/**
 * ASCII cat status indicator for thread sidebar.
 * Shows ᓚᘏᗢ with CSS animation + color based on aggregate thread state.
 */

export function ThreadCatStatus({
  presence,
  unreadCount,
  hasUserMention,
}: {
  presence: SidebarPresence;
  unreadCount: number;
  hasUserMention?: boolean;
}) {
  const status = presence.status;

  if (status === 'idle' && unreadCount === 0 && !hasUserMention) return null;

  const statusClasses: Record<string, string> = {
    idle: 'text-cafe-muted',
    working: 'text-conn-amber-text animate-cat-bounce',
    done: 'text-conn-emerald-text',
    error: 'text-conn-red-text animate-cat-shake',
  };

  const tooltip = presence.cats?.length ? `${status}: ${presence.cats.join(', ')}` : status;

  return (
    <span className="inline-flex items-center gap-0.5 flex-shrink-0">
      {status !== 'idle' && (
        <span className={`text-xs ${statusClasses[status]}`} title={tooltip}>
          ᓚᘏᗢ
        </span>
      )}
      {status === 'done' && <span className="text-conn-emerald-text text-micro">&#10003;</span>}
      {hasUserMention && (
        <span title="猫猫 @ 了你">
          <PawIcon className="text-xs" />
        </span>
      )}
      {unreadCount > 0 && (
        <span
          className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[var(--cafe-surface)] text-micro font-bold leading-none ${
            hasUserMention ? 'bg-conn-red-text' : 'bg-[var(--semantic-warning)]'
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
