import type { ReactNode } from 'react';

interface SettingsFieldProps {
  label: string;
  hint?: string;
  inline?: boolean;
  compact?: boolean;
  badge?: ReactNode;
  children: ReactNode;
}

export function SettingsField({ label, hint, inline, compact, badge, children }: SettingsFieldProps) {
  if (inline) {
    const labelSize = compact ? 'text-xs text-cafe-secondary' : 'text-sm font-medium text-cafe';
    return (
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={labelSize}>{label}</span>
            {badge}
          </div>
          {hint && <p className="mt-0.5 text-xs text-cafe-muted">{hint}</p>}
        </div>
        <div className={compact ? 'shrink-0 text-xs font-medium text-cafe-secondary' : 'shrink-0'}>{children}</div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium text-cafe">{label}</label>
        {badge}
      </div>
      {hint && <p className="text-xs text-cafe-muted">{hint}</p>}
      <div>{children}</div>
    </div>
  );
}
