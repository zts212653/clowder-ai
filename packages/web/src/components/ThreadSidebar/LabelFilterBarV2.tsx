'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppTooltip } from '../AppTooltip';
import { useShellCopy } from '../shell/shell-copy';
import type { LabelFilterBarProps } from './LabelFilterBar';
import { SidebarFilterItemV2, SidebarFilterMenuV2 } from './SidebarFilterMenuV2';
import { threadSignalsCopy } from './thread-signals.shell-copy';

export function LabelFilterBarV2({
  labels,
  selectedFilter,
  onSelect,
  uncategorizedCount,
  open,
  onOpenChange,
}: LabelFilterBarProps) {
  const copy = useShellCopy(threadSignalsCopy);
  const [localOpen, setLocalOpen] = useState(false);
  const shown = open ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const close = useCallback(() => setOpen(false), [setOpen]);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedName =
    selectedFilter === '__uncategorized__'
      ? copy.uncategorized
      : labels.find((label) => label.id === selectedFilter)?.name;
  useEffect(() => {
    if (!shown) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [shown, close]);
  const select = (filter: string | null) => {
    onSelect(filter === selectedFilter ? null : filter);
    close();
    triggerRef.current?.focus();
  };
  const items = [
    { id: null, name: copy.allConversations },
    {
      id: '__uncategorized__',
      name: `${copy.uncategorized}${uncategorizedCount > 0 ? ` (${uncategorizedCount})` : ''}`,
    },
    ...labels,
  ];
  return (
    <div
      ref={rootRef}
      className="flex min-w-0 items-center rounded-lg"
      style={{ background: selectedFilter ? 'var(--shell-selected)' : undefined }}
    >
      <AppTooltip
        label={selectedName ? `${copy.labels} · ${selectedName}` : copy.labels}
        side="right"
        intent="content"
        onlyWhenTruncated
        disabled={shown}
      >
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={shown}
          onClick={() => setOpen(!shown)}
          data-testid="sidebar-label-filter-trigger"
          className="shell-rail-item shell-focusable flex h-7 min-w-0 items-center rounded-lg px-2 text-xs"
          style={{ color: 'var(--shell-body)' }}
        >
          <span className="truncate">
            {copy.labels}
            {selectedName ? ` · ${selectedName}` : ''}
          </span>
        </button>
      </AppTooltip>
      {selectedFilter && (
        <AppTooltip label={copy.clearFilter} side="right">
          <button
            type="button"
            data-testid="sidebar-label-filter-clear"
            aria-label={copy.clearFilter}
            className="shell-focusable h-7 w-5 shrink-0 rounded-lg text-sm"
            style={{ color: 'var(--shell-body)' }}
            onClick={() => select(null)}
          >
            ×
          </button>
        </AppTooltip>
      )}
      {shown && (
        <SidebarFilterMenuV2
          label={copy.labels}
          triggerRef={triggerRef}
          onClose={close}
          testId="sidebar-label-filter-menu"
        >
          {items.map((item) => (
            <SidebarFilterItemV2
              key={item.id ?? 'all'}
              name={item.name}
              labelId={item.id ?? 'all'}
              selected={selectedFilter === item.id}
              onClick={() => select(item.id)}
              leading={
                <span
                  className="h-2 w-2 shrink-0 rounded-full border"
                  style={{
                    background: 'color' in item && item.color ? item.color : undefined,
                    borderColor: 'color' in item && item.color ? item.color : 'var(--shell-muted)',
                  }}
                />
              }
            />
          ))}
        </SidebarFilterMenuV2>
      )}
    </div>
  );
}
