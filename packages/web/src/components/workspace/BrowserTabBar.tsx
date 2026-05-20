'use client';

import type { BrowserTab } from './BrowserPanel';

interface BrowserTabBarProps {
  tabs: BrowserTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
}

export function BrowserTabBar({ tabs, activeTabId, onSelect, onClose, onAdd }: BrowserTabBarProps) {
  return (
    <div className="flex items-center bg-[var(--ws-surface-warm)] border-b border-[var(--console-border-soft)] overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            className={`group flex items-center gap-1 px-3 py-1.5 text-xs border-r border-[var(--console-border-soft)]/50 shrink-0 max-w-[180px] transition-colors ${
              isActive
                ? 'bg-[var(--ws-surface)] text-[var(--ws-text)] font-medium'
                : 'text-[var(--ws-text)]/60 hover:text-[var(--ws-text)] hover:bg-[var(--ws-surface)]/50'
            }`}
          >
            <span className="truncate">{tab.title}</span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className="ml-1 opacity-0 group-hover:opacity-100 text-[var(--ws-text)]/40 hover:text-[var(--ws-text)]"
              role="button"
              tabIndex={-1}
              onKeyDown={() => {}}
            >
              ×
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        className="px-2 py-1.5 text-xs text-[var(--ws-text)]/40 hover:text-[var(--ws-text)] hover:bg-[var(--ws-surface)]/50 transition-colors shrink-0"
        title="New tab"
      >
        +
      </button>
    </div>
  );
}
