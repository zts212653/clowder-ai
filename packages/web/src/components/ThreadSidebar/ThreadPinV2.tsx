'use client';

import { useShellCopy } from '../shell/shell-copy';
import { threadSignalsCopy } from './thread-signals.shell-copy';

/** A filled mark identifies a pinned conversation; an empty mark offers pinning. */
export function SidebarPinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0"
      fill={pinned ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <path d="m5 2 6 2-2 2 1 4-3-1-2 3-1-4-2-1zM5 10l-2 4" />
    </svg>
  );
}

/** A read-only pin indicator; pin commands live in the sidebar row menu. */
export function ThreadPinV2({ id, pinned = false }: { id: string; pinned?: boolean }) {
  const copy = useShellCopy(threadSignalsCopy);
  const slotClass = 'inline-flex h-5 w-4 flex-none items-center justify-center';
  if (id === 'default' || !pinned) return <span data-sidebar-pin-slot aria-hidden="true" className={slotClass} />;
  return (
    <span data-sidebar-pin-slot className={slotClass}>
      <span
        role="img"
        aria-label={copy.pinned}
        data-testid="thread-pin-mark"
        className={slotClass}
        style={{ color: 'var(--shell-primary)' }}
      >
        <SidebarPinIcon pinned />
      </span>
    </span>
  );
}
