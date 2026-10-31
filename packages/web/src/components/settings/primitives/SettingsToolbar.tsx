import type { ReactNode } from 'react';

interface SettingsToolbarProps {
  children: ReactNode;
}

export function SettingsToolbar({ children }: SettingsToolbarProps) {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-[var(--console-panel-bg)] p-3 sm:flex-row sm:items-center sm:justify-between">
      {children}
    </div>
  );
}

interface SettingsSearchInputProps {
  icon?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

export function SettingsSearchInput({ icon, value, onChange, placeholder }: SettingsSearchInputProps) {
  return (
    <label className="flex min-w-[220px] items-center gap-2 rounded-lg border border-[var(--console-border-soft)] bg-transparent px-3 py-2 text-xs text-cafe-muted transition-shadow focus-within:bg-[var(--console-card-bg)] focus-within:ring-1 focus-within:ring-[var(--console-input-stroke)]">
      {icon}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-cafe-secondary outline-none placeholder:text-cafe-muted"
      />
    </label>
  );
}
