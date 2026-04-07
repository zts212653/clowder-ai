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
      className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors bg-cocreator-primary/10 text-cocreator-primary border border-cocreator-primary/20 hover:bg-cocreator-primary/15 disabled:opacity-30 disabled:cursor-not-allowed ${className ?? ''}`}
    >
      {label}
    </button>
  );
}
