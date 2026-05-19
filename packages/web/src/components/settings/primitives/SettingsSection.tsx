import type { ReactNode } from 'react';

interface SettingsSectionProps {
  title: string;
  description?: string;
  badge?: ReactNode;
  children: ReactNode;
}

export function SettingsSection({ title, description, badge, children }: SettingsSectionProps) {
  return (
    <section className="rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-[18px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-cafe">{title}</h3>
          {description && <p className="mt-1 max-w-2xl text-sm leading-6 text-cafe-secondary">{description}</p>}
        </div>
        {badge}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}
