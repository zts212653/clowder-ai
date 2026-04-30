'use client';

interface FocusModeButtonProps {
  label?: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}

/**
 * Compact focus-mode trigger — rendered in pane toolbars (not tab bar).
 * Pane-level action, not a view mode switch.
 */
export function FocusModeButton({ label = '专注', disabled, className, onClick }: FocusModeButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border border-[var(--console-border-soft)] bg-[var(--console-active-bg)] px-2 py-1 text-[10px] font-medium text-cafe-accent transition-colors hover:bg-[var(--console-hover-bg)] disabled:cursor-not-allowed disabled:opacity-30 ${className ?? ''}`}
    >
      {label}
    </button>
  );
}
