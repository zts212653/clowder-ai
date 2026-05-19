import type { ReactNode } from 'react';

interface SettingsPrimaryButtonProps {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  'data-guide-id'?: string;
  'data-bootcamp-step'?: string;
}

export function SettingsPrimaryButton({ onClick, disabled, children, ...rest }: SettingsPrimaryButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 rounded-full bg-cafe-accent px-4 py-1.5 text-xs font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:cursor-not-allowed disabled:opacity-50 transition"
      {...rest}
    >
      {children}
    </button>
  );
}
