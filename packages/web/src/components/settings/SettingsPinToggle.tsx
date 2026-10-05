'use client';

import { AppTooltip } from '../AppTooltip';

/** Pin / unpin a 设置与管理 item above the mailbox. The accessible name carries the item's own label. */
export function PinToggle({ pinned, label, onToggle }: { pinned: boolean; label: string; onToggle: () => void }) {
  const text = pinned ? `取消固定「${label}」到侧栏` : `固定「${label}」到侧栏`;
  return (
    <AppTooltip label={text} side="bottom">
      <button
        type="button"
        onClick={onToggle}
        aria-label={text}
        aria-pressed={pinned}
        data-testid="settings-pin-toggle"
        className="shell-focusable flex h-6 w-6 flex-none items-center justify-center rounded"
        style={{ color: pinned ? 'var(--shell-ink)' : 'var(--shell-muted)', opacity: pinned ? 1 : 0.75 }}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill={pinned ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.2"
          className="h-3 w-3"
        >
          <path d="M9.5 1.5l5 5-3 1-2 3-3.5-3.5-4 4M6.5 7L3 10.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </AppTooltip>
  );
}
