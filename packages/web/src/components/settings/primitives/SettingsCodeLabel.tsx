import type { ReactNode } from 'react';

interface SettingsCodeLabelProps {
  children: ReactNode;
  className?: string;
}

export function SettingsCodeLabel({ children, className }: SettingsCodeLabelProps) {
  return (
    <code
      className={`shrink-0 rounded bg-[var(--console-field-bg)] px-1.5 py-0.5 font-mono text-xs text-cafe-secondary${className ? ` ${className}` : ''}`}
    >
      {children}
    </code>
  );
}
