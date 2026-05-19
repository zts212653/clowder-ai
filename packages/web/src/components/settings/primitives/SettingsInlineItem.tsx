import type { ReactNode } from 'react';

interface SettingsInlineItemProps {
  children: ReactNode;
  className?: string;
}

export function SettingsInlineItem({ children, className }: SettingsInlineItemProps) {
  return (
    <div
      className={`flex items-baseline gap-2 rounded-xl border border-[var(--console-border-soft)] bg-cafe-surface px-3 py-2${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}
