'use client';

interface FilterTab {
  key: string;
  label: string;
  count?: number;
}

interface SettingsFilterTabsProps {
  tabs: FilterTab[];
  activeKey: string;
  onTabChange: (key: string) => void;
}

export function SettingsFilterTabs({ tabs, activeKey, onTabChange }: SettingsFilterTabsProps) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {tabs.map((tab) => {
        const isActive = tab.key === activeKey;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onTabChange(tab.key)}
            className={`rounded-full px-3 py-1 font-medium transition ${
              isActive
                ? 'bg-cafe-accent text-[var(--cafe-accent-foreground)]'
                : 'text-cafe-secondary hover:bg-[var(--console-hover-bg)] hover:text-cafe'
            }`}
          >
            {tab.label}
            {tab.count != null && (
              <span className={`ml-1 ${isActive ? 'opacity-80' : 'text-cafe-muted'}`}>{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
