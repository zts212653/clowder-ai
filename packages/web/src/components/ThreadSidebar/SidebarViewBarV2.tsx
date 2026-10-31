'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreadLabel } from '@/stores/label-store';
import { AppTooltip } from '../AppTooltip';
import { ShellGlyph } from '../shell/ShellIcons';
import { useShellCopy } from '../shell/shell-copy';
import { LabelFilterBar } from './LabelFilterBar';
import { SidebarFilterItemV2, SidebarFilterMenuV2 } from './SidebarFilterMenuV2';
import { SidebarTabIcon } from './SidebarTabIcon';
import { threadSignalsCopy } from './thread-signals.shell-copy';
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
  const copy = useShellCopy(threadSignalsCopy);
  const [menu, setMenu] = useState<'group' | 'label' | null>(null);
  const open = menu === 'group';
  const setOpen = (open: boolean) => setMenu(open ? 'group' : null);
  const close = useCallback(() => setMenu(null), []);
  const onLabelOpen = useCallback((open: boolean) => setMenu(open ? 'label' : null), []);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = tabs.find((tab) => tab.id === activeTab);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-1 px-3 py-1.5"
      style={{ background: 'var(--shell-frame)' }}
      data-testid="sidebar-tabs-row"
      data-scroll-occluder="true"
    >
      <div ref={rootRef} className="min-w-0 max-w-[55%]">
        <AppTooltip label={copy.groupingTip} side="right" intent="content" disabled={open}>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen(!open)}
            aria-haspopup="menu"
            aria-expanded={open}
            data-testid="sidebar-view-menu"
            className="shell-rail-item shell-focusable inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded-lg px-2 text-xs"
            style={{ color: 'var(--shell-body)', background: 'var(--shell-selected)' }}
          >
            <span className="shrink-0">{copy.grouping}</span>
            <span className="truncate" style={{ color: 'var(--shell-ink)' }}>
              {current ? copy[current.id] : ''}
            </span>
            <ShellGlyph name="chevronDown" className="h-3 w-3" />
          </button>
        </AppTooltip>
        {open && (
          <SidebarFilterMenuV2 label={copy.grouping} triggerRef={triggerRef} onClose={close}>
            {tabs.map((tab) => (
              <SidebarFilterItemV2
                key={tab.id}
                name={copy[tab.id]}
                selected={tab.id === activeTab}
                testId={`sidebar-tab-${tab.id}`}
                onClick={() => {
                  onSelectTab(tab.id);
                  close();
                  triggerRef.current?.focus();
                }}
                leading={<SidebarTabIcon id={tab.id} className="h-3.5 w-3.5 shrink-0" />}
                trailing={
                  <span className="text-xs tabular-nums" style={{ color: 'var(--shell-muted)' }}>
                    {tab.count}
                  </span>
                }
              />
            ))}
          </SidebarFilterMenuV2>
        )}
      </div>
      <LabelFilterBar
        variant="v2"
        open={menu === 'label'}
        onOpenChange={onLabelOpen}
        labels={labels}
        selectedFilter={labelFilter}
        onSelect={onLabelFilter}
        uncategorizedCount={uncategorizedCount}
      />
    </div>
  );
}
