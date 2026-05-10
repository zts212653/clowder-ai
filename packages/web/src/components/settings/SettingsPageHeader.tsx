import type { ReactNode } from 'react';

interface SettingsPageHeaderProps {
  title: string;
  subtitle: string;
  children?: ReactNode;
}

export function SettingsPageHeader({ title, subtitle, children }: SettingsPageHeaderProps) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="text-2xl font-extrabold text-cafe">{title}</h2>
        <p className="text-compact leading-tight text-cafe-secondary">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}
