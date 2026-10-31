import type { ReactNode } from 'react';
import { SettingsCard } from './SettingsCard';
import { SettingsText } from './SettingsText';

export function SettingsEmptyState({
  icon,
  title,
  description,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <SettingsCard className="flex flex-col items-center justify-center px-8 py-16 text-center">
      {icon}
      <SettingsText as="p" variant="base" tone="default" className="font-semibold">
        {title}
      </SettingsText>
      {description && (
        <SettingsText as="p" tone="muted" className="mt-1">
          {description}
        </SettingsText>
      )}
    </SettingsCard>
  );
}
