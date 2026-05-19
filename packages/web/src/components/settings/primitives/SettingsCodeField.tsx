import type { InputHTMLAttributes, ReactNode } from 'react';

const fieldBase =
  'rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-field-bg)] px-3 py-2 text-xs text-cafe-secondary';

export function SettingsCodeField(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  return <input className={`w-full ${fieldBase} font-mono`} {...props} />;
}

export function SettingsReadOnlyField({ children }: { children: ReactNode }) {
  return <div className={`${fieldBase} border-dashed`}>{children}</div>;
}

export function SettingsVarRow({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 py-2 text-xs md:grid-cols-[minmax(0,1fr)_220px]">{children}</div>;
}
