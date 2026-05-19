import type { ReactNode } from 'react';

type StripTone = 'info' | 'success' | 'warn' | 'error' | 'muted';

interface SettingsStatusStripProps {
  tone: StripTone;
  size?: 'sm' | 'xs';
  bordered?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}

const colorStyles: Record<StripTone, string> = {
  info: 'bg-conn-blue-bg text-conn-blue-text',
  success: 'bg-conn-emerald-bg text-conn-emerald-text',
  warn: 'bg-conn-amber-bg text-conn-amber-text',
  error: 'bg-conn-red-bg text-conn-red-text',
  muted: 'text-cafe-muted',
};

const borderedColorStyles: Record<StripTone, string> = {
  info: 'border border-conn-blue-ring bg-conn-blue-bg text-conn-blue-text',
  success: 'border border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text',
  warn: 'border border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
  error: 'border border-conn-red-ring bg-conn-red-bg text-conn-red-text',
  muted: 'border border-[var(--console-border-soft)] text-cafe-muted',
};

export function SettingsStatusStrip({ tone, size = 'sm', bordered, actions, children }: SettingsStatusStripProps) {
  const isMutedFlat = tone === 'muted' && !bordered;
  const colors = bordered ? borderedColorStyles[tone] : colorStyles[tone];
  const base = isMutedFlat ? '' : 'rounded-lg px-3 py-2 font-medium';
  const sizeClass = size === 'xs' ? 'text-xs' : 'text-sm';
  const className = [base, sizeClass, colors].filter(Boolean).join(' ');

  if (actions) {
    return (
      <div className={`flex items-center justify-between ${className}`}>
        <div className="flex items-center gap-3">{children}</div>
        {actions}
      </div>
    );
  }
  return <p className={className}>{children}</p>;
}
