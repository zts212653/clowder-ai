import type { InputHTMLAttributes, ReactNode } from 'react';
import { formInputClass } from '../../mcp-form-helpers';

export function SettingsCodeField(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  return <input className={`w-full font-mono ${formInputClass}`} {...props} />;
}

export function SettingsReadOnlyField({ children }: { children: ReactNode }) {
  return <div className={`${formInputClass} border-dashed !border-[var(--console-border-soft)]`}>{children}</div>;
}

export function SettingsVarRow({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 py-2 text-xs md:grid-cols-[minmax(0,1fr)_300px]">{children}</div>;
}
