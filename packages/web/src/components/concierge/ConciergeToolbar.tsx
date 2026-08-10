'use client';

/**
 * F229 ConciergeToolbar — 猫的能力工具栏（Layer 2）
 *
 * surfaceState=toolbar 时渲染，其他态返回 null
 * 单一、清晰的对话入口
 * 全部颜色从 OKLCH token 来，零 Tailwind 原生色
 *
 * 能力引导放到空面板内，避免工具栏出现两个几乎相同的入口。
 */

import { useEffect } from 'react';
import { useConciergeStore } from '@/stores/conciergeStore';

// Inline SVG icons (no icon library dependency)
const ChatIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M2 3.5C2 2.67 2.67 2 3.5 2h9c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5H5L2 14V3.5z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

export function ConciergeToolbar() {
  const surfaceState = useConciergeStore((s) => s.surfaceState);
  const setSurfaceState = useConciergeStore((s) => s.setSurfaceState);

  // P2 cloud fix: second-level Escape — toolbar → collapsed (mirrors ConciergePanel's bubble → toolbar)
  // Guard inside effect so the listener is only registered (and removed on cleanup) when in toolbar state.
  useEffect(() => {
    if (surfaceState !== 'toolbar') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSurfaceState('collapsed');
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [surfaceState, setSurfaceState]);

  if (surfaceState !== 'toolbar') return null;

  return (
    <div
      data-testid="concierge-toolbar"
      className="absolute top-[calc(100%+8px)] left-1/2 -translate-x-1/2 flex flex-row items-center gap-2 pointer-events-auto"
      role="toolbar"
      aria-label="猫猫能力工具栏"
    >
      <button
        type="button"
        aria-label="聊聊"
        style={{ backgroundColor: 'var(--accent-100)' }}
        className={[
          'concierge-tool pointer-events-auto',
          'flex h-9 items-center justify-center gap-1.5 rounded-full px-3',
          'text-xs font-medium text-[color:var(--cafe-text-secondary)]',
          'shadow-[var(--shadow-elevation-1)]',
          'border border-[color:var(--cafe-border-subtle)]',
          'transition-all duration-200 hover:scale-105 hover:bg-[var(--accent-200)]',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cafe-accent)]',
        ].join(' ')}
        onClick={() => setSurfaceState('bubble', '')}
      >
        <ChatIcon />
        <span>聊聊</span>
      </button>
    </div>
  );
}
