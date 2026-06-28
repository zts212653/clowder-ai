import type { ReactNode } from 'react';

interface SettingsSectionProps {
  title: string;
  description?: string;
  badge?: ReactNode;
  children?: ReactNode;
}

export function SettingsSection({ title, description, badge, children }: SettingsSectionProps) {
  return (
    <section className="rounded-xl bg-[var(--console-card-bg)] p-[18px] shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-cafe">{title}</h3>
          {description && <p className="mt-1 max-w-2xl text-sm leading-6 text-cafe-secondary">{description}</p>}
        </div>
        {badge}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}
