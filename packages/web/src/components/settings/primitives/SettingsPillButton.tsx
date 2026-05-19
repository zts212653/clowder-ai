import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function SettingsPillButton({
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-full border border-[var(--console-border-soft)] px-2 py-0.5 text-xs transition-colors hover:border-[var(--console-border-strong)] hover:bg-[var(--console-hover-bg)]"
    >
      {children}
    </button>
  );
}
