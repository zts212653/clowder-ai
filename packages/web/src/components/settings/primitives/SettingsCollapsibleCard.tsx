import type { ReactNode } from 'react';
import { SettingsBadge } from './SettingsBadge';
import { SettingsText } from './SettingsText';

interface SettingsCollapsibleCardProps {
  title: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function SettingsCollapsibleCard({ title, count, collapsed, onToggle, children }: SettingsCollapsibleCardProps) {
  return (
    <div className="console-list-card overflow-hidden rounded-2xl shadow-[0_4px_16px_rgba(43,33,26,0.05)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-[var(--console-hover-bg)]"
      >
        <SettingsText
          variant="xs"
          tone="muted"
          className="transition-transform"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
        >
          ▾
        </SettingsText>
        <SettingsText variant="sm" tone="default" className="font-semibold">
          {title}
        </SettingsText>
        {count !== undefined && (
          <SettingsBadge tone="slate" size="xxs">
            {count}
          </SettingsBadge>
        )}
      </button>
      {!collapsed && <div className="divide-y divide-[var(--console-border-soft)] px-4 pb-2">{children}</div>}
    </div>
  );
}

interface SettingsCardSubSectionProps {
  label?: string;
  children: ReactNode;
}

export function SettingsCardSubSection({ label, children }: SettingsCardSubSectionProps) {
  return (
    <div className="border-t border-[var(--console-border-soft)] px-4 pb-3 pt-2">
      {label && (
        <SettingsText variant="micro" tone="muted" className="font-medium uppercase tracking-wider">
          {label}
        </SettingsText>
      )}
      {children}
    </div>
  );
}
