import type { ReactNode } from 'react';

interface SettingsSecondaryButtonProps {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}

export function SettingsSecondaryButton({ onClick, disabled, children }: SettingsSecondaryButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 rounded-full border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-4 py-1.5 text-xs font-semibold text-cafe transition hover:bg-[var(--console-hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}
