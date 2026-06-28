'use client';

/**
 * F246 Phase C: Responsive workspace tab bar.
 *
 * Dynamically adapts to panel width:
 * - Wide: all tabs expanded (icon + text)
 * - Medium: visible tabs + overflow "⋯" dropdown
 * - Narrow: icon-only mode + overflow
 *
 * operator design decision (2026-06-21): "动态计算！按照用户给workspace拉的宽度来匹配"
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';

type WorkspaceMode = 'dev' | 'recall' | 'schedule' | 'tasks' | 'community' | 'artifacts' | 'approval' | 'trajectory';

interface TabDef {
  mode: WorkspaceMode;
  label: string;
  icon: ReactNode;
  /** Special active style (e.g., recall uses accent color) */
  activeClass?: string;
}

const TABS: TabDef[] = [
  {
    mode: 'dev',
    label: '开发',
    icon: <span className="text-xs">&lt;/&gt;</span>,
  },
  {
    mode: 'recall',
    label: '记忆',
    activeClass: 'bg-cafe-accent/10 text-cafe-accent border border-cafe-accent/30',
    icon: (
      <svg
        className="w-3 h-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
        <path d="M9 17l3 5v-5M15 17l-3 5" />
      </svg>
    ),
  },
  {
    mode: 'schedule',
    label: '调度',
    icon: (
      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0a8 8 0 110 16A8 8 0 018 0zm0 2a6 6 0 100 12A6 6 0 008 2zm.5 2v4.25l2.85 2.85a.5.5 0 01-.7.7L7.8 8.95A.5.5 0 017.5 8.6V4a.5.5 0 011 0z" />
      </svg>
    ),
  },
  {
    mode: 'tasks',
    label: '任务',
    icon: (
      <svg
        className="w-3 h-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="1" />
      </svg>
    ),
  },
  {
    mode: 'community',
    label: '社区',
    icon: (
      <svg
        className="w-3 h-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
  },
  {
    mode: 'artifacts',
    label: '产物',
    icon: (
      <svg
        className="w-3 h-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    ),
  },
  {
    mode: 'approval',
    label: '审批',
    icon: (
      <svg
        className="w-3 h-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        <path d="m9 14 2 2 4-4" />
      </svg>
    ),
  },
  {
    mode: 'trajectory',
    label: '轨迹',
    icon: (
      <svg
        className="w-3 h-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="6" cy="5" r="2" />
        <circle cx="6" cy="19" r="2" />
        <path d="M6 7v10M6 5h10a4 4 0 0 1 0 8H9" />
      </svg>
    ),
  },
];

const DEFAULT_ACTIVE = 'bg-cafe-surface text-cafe-interactive border border-cafe-subtle/60';
const INACTIVE = 'text-cafe-interactive/40 hover:text-cafe-interactive/60';

/** Pixels per tab: icon (12) + gap (4) + text (~24) + padding (20) ≈ 60 */
const TAB_FULL_WIDTH = 60;
/** Pixels per icon-only tab: px-2.5 (20) + icon w-3 (12) = 32 */
const TAB_ICON_WIDTH = 32;
/** Overflow button width */
const OVERFLOW_WIDTH = 32;
/** gap-1 between flex children */
const GAP_WIDTH = 4;
/** Horizontal padding of the container */
const CONTAINER_PADDING = 24; // px-3 = 12px × 2

export function WorkspaceTabBar() {
  const workspaceMode = useChatStore((s) => s.workspaceMode);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const barRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(9999); // start wide to avoid flash
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Measure container width
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setBarWidth(entry.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Close overflow on outside click
  useEffect(() => {
    if (!overflowOpen) return;
    const handler = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [overflowOpen]);

  const usableWidth = barWidth - CONTAINER_PADDING;
  // Include inter-tab gaps: N tabs need N × width + (N-1) × gap
  const allFitFull = usableWidth >= TABS.length * TAB_FULL_WIDTH + (TABS.length - 1) * GAP_WIDTH;
  const iconOnly =
    !allFitFull && usableWidth < TABS.length * TAB_ICON_WIDTH + (TABS.length - 1) * GAP_WIDTH + OVERFLOW_WIDTH;

  // How many tabs can we show? Each tab costs tabWidth + one gap (except last visible has gap before overflow)
  const tabWidth = iconOnly ? TAB_ICON_WIDTH : TAB_FULL_WIDTH;
  const effectiveTabWidth = tabWidth + GAP_WIDTH; // tab + trailing gap
  const visibleCount = allFitFull
    ? TABS.length
    : Math.max(1, Math.floor((usableWidth - OVERFLOW_WIDTH) / effectiveTabWidth));

  const visibleTabs = TABS.slice(0, visibleCount);
  const overflowTabs = TABS.slice(visibleCount);

  // If current mode is in overflow, swap it into visible range
  const activeInOverflow = overflowTabs.findIndex((t) => t.mode === workspaceMode);
  if (activeInOverflow >= 0 && visibleTabs.length > 0) {
    // Swap: put the active tab in the last visible slot
    const swapOut = visibleTabs[visibleTabs.length - 1];
    visibleTabs[visibleTabs.length - 1] = overflowTabs[activeInOverflow];
    overflowTabs[activeInOverflow] = swapOut;
  }

  const handleTabClick = useCallback(
    (mode: WorkspaceMode) => {
      setWorkspaceMode(mode);
      setOverflowOpen(false);
    },
    [setWorkspaceMode],
  );

  return (
    <div
      ref={barRef}
      className="flex items-center gap-1 px-3 py-1.5 bg-cafe-surface/50"
      data-testid="workspace-tab-bar"
    >
      {visibleTabs.map((tab) => {
        const isActive = workspaceMode === tab.mode;
        const activeClass = tab.activeClass ?? DEFAULT_ACTIVE;
        return (
          <button
            key={tab.mode}
            type="button"
            onClick={() => handleTabClick(tab.mode)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-micro font-semibold transition-all ${isActive ? activeClass : INACTIVE}`}
            title={iconOnly ? tab.label : undefined}
            data-testid={`workspace-tab-${tab.mode}`}
          >
            {tab.icon}
            {!iconOnly && tab.label}
          </button>
        );
      })}

      {/* Overflow button */}
      {overflowTabs.length > 0 && (
        <div ref={overflowRef} className="relative">
          <button
            type="button"
            onClick={() => setOverflowOpen((p) => !p)}
            className={`flex items-center justify-center w-7 h-6 rounded-full text-micro font-bold transition-all ${overflowOpen ? DEFAULT_ACTIVE : INACTIVE}`}
            title="更多"
            data-testid="workspace-tab-overflow-btn"
          >
            ⋯
          </button>
          {overflowOpen && (
            <div
              className="absolute top-full left-0 mt-1 py-1 min-w-[120px] rounded-lg border border-cafe-subtle/60 bg-[var(--console-card-bg)] shadow-lg z-20"
              data-testid="workspace-tab-overflow-menu"
            >
              {overflowTabs.map((tab) => {
                const isActive = workspaceMode === tab.mode;
                return (
                  <button
                    key={tab.mode}
                    type="button"
                    onClick={() => handleTabClick(tab.mode)}
                    className={`flex items-center gap-2 w-full px-3 py-1.5 text-micro font-semibold text-left transition-all hover:bg-cafe-surface ${isActive ? 'text-cafe-interactive' : 'text-cafe-interactive/60'}`}
                    data-testid={`workspace-tab-overflow-${tab.mode}`}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
