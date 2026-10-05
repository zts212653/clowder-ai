'use client';

import { useEffect, useRef, useState } from 'react';
import type { ThreadLabel } from '@/stores/label-store';
import { AppTooltip } from '../AppTooltip';
import { ShellGlyph } from '../shell/ShellIcons';
import { LabelFilterBar } from './LabelFilterBar';
import { SidebarTabIcon } from './SidebarTabIcon';
import type { SidebarTab, SidebarTabId } from './thread-utils';

/**
 * Café 1.6 list head: the six always-visible tabs become one "分组" menu plus the existing label filter.
 * It drives the SAME tab state (handleSelectTab → sidebarTabReducer), so F277 grouping, counts and the remembered
 * choice behave exactly as before; only the presentation is calmer.
 */
export function SidebarViewBarV2({
  tabs,
  activeTab,
  onSelectTab,
  labels,
  labelFilter,
  onLabelFilter,
  uncategorizedCount,
}: {
  tabs: readonly SidebarTab[];
  activeTab: SidebarTabId;
  onSelectTab: (tab: SidebarTabId) => void;
  labels: ThreadLabel[];
  labelFilter: string | null;
  onLabelFilter: (filter: string | null) => void;
  uncategorizedCount: number;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = tabs.find((tab) => tab.id === activeTab);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-1 px-3 py-1.5"
      style={{ background: 'var(--shell-frame)' }}
      data-testid="sidebar-tabs-row"
      data-scroll-occluder="true"
    >
      <div ref={rootRef} className="relative">
        <AppTooltip label="切换对话的分组方式" side="bottom" disabled={open}>
          <button
            type="button"
            onClick={() => setOpen((wasOpen) => !wasOpen)}
            aria-haspopup="menu"
            aria-expanded={open}
            data-testid="sidebar-view-menu"
            className="shell-rail-item shell-focusable inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs"
            style={{ color: 'var(--shell-body)' }}
          >
            <span>分组</span>
            <span style={{ color: 'var(--shell-ink)' }}>{current?.label ?? ''}</span>
            <ShellGlyph name="chevronDown" className="h-3 w-3" />
          </button>
        </AppTooltip>
        {open && (
          <div
            role="menu"
            aria-label="对话分组"
            className="absolute left-0 top-8 z-[60] w-[200px] rounded-xl p-1.5"
            style={{
              background: 'var(--shell-paper)',
              border: '1px solid var(--shell-hairline-strong)',
              boxShadow: '0 4px 10px rgb(20 20 19 / 0.1)',
            }}
          >
            {tabs.map((tab) => {
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-testid={`sidebar-tab-${tab.id}`}
                  onClick={() => {
                    onSelectTab(tab.id);
                    setOpen(false);
                  }}
                  className="shell-nav-row shell-focusable flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm"
                  data-selected={selected ? 'true' : undefined}
                  style={{
                    background: selected ? 'var(--shell-selected)' : undefined,
                    color: selected ? 'var(--shell-ink)' : 'var(--shell-body)',
                  }}
                >
                  <span className="flex-none" style={{ color: 'var(--shell-muted)' }}>
                    <SidebarTabIcon id={tab.id} className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                  <span className="text-xs tabular-nums" style={{ color: 'var(--shell-muted)' }}>
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <LabelFilterBar
        labels={labels}
        selectedFilter={labelFilter}
        onSelect={onLabelFilter}
        uncategorizedCount={uncategorizedCount}
      />
    </div>
  );
}
