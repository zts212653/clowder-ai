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
    <div className="flex items-center bg-[#F5F0EB] border-b border-[#FFDDD2] overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            className={`group flex items-center gap-1 px-3 py-1.5 text-[11px] border-r border-[#FFDDD2]/50 shrink-0 max-w-[180px] transition-colors ${
              isActive
                ? 'bg-[#FDF8F3] text-[#5a4a42] font-medium'
                : 'text-[#5a4a42]/60 hover:text-[#5a4a42] hover:bg-[#FDF8F3]/50'
            }`}
          >
            <span className="truncate">{tab.title}</span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className="ml-1 opacity-0 group-hover:opacity-100 text-[#5a4a42]/40 hover:text-[#5a4a42]"
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
        className="px-2 py-1.5 text-[11px] text-[#5a4a42]/40 hover:text-[#5a4a42] hover:bg-[#FDF8F3]/50 transition-colors shrink-0"
        title="New tab"
      >
        +
      </button>
    </div>
  );
}
