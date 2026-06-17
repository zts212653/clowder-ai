'use client';

/**
 * F229 ConciergeToolbar — 猫的能力工具栏（Layer 2）
 *
 * surfaceState=toolbar 时渲染，其他态返回 null
 * 两个诚实入口 + stagger 动画（0/80ms）
 * 全部颜色从 OKLCH token 来，零 Tailwind 原生色
 *
 * 按钮动作（co-creator拍板简化：四假按钮 → 两诚实入口）：
 *   ? → setSurfaceState('bubble') + 预填"你能帮我什么？"（能力引导）
 *   💬 → setSurfaceState('bubble') 空气泡（直接聊）
 */

import { useEffect } from 'react';
import { useConciergeStore } from '@/stores/conciergeStore';

// Inline SVG icons (no icon library dependency)
const HelpIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M6.5 6.2c0-1 .7-1.7 1.5-1.7s1.5.7 1.5 1.7c0 .7-.4 1.1-1 1.4-.3.2-.5.4-.5.9"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <circle cx="8" cy="11" r="0.8" fill="currentColor" />
  </svg>
);

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

const TOOLS = [
  {
    key: 'help',
    label: '能帮什么',
    icon: <HelpIcon />,
    prompt: '你能帮我什么？',
  },
  {
    key: 'chat',
    label: '聊聊',
    icon: <ChatIcon />,
    prompt: '',
  },
] as const;

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
      className="absolute bottom-[calc(100%+8px)] right-0 flex flex-col items-end gap-2 pointer-events-auto"
      role="toolbar"
      aria-label="猫猫能力工具栏"
    >
      {TOOLS.map((tool, i) => (
        <button
          key={tool.key}
          type="button"
          aria-label={tool.label}
          title={tool.label}
          style={{
            transitionDelay: `${i * 80}ms`,
            backgroundColor: 'var(--accent-100)',
          }}
          className={[
            'concierge-tool',
            'pointer-events-auto',
            'flex items-center justify-center',
            'w-9 h-9 rounded-full',
            'text-[color:var(--cafe-text-secondary)]',
            'shadow-[var(--shadow-elevation-1)]',
            'border border-[color:var(--cafe-border-subtle)]',
            'transition-all duration-200',
            'hover:scale-110',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cafe-accent)]',
          ].join(' ')}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-200)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-100)';
          }}
          onClick={() => setSurfaceState('bubble', tool.prompt)}
        >
          {tool.icon}
        </button>
      ))}
    </div>
  );
}
