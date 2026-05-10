'use client';

import { SettingsPageHeader } from './SettingsPageHeader';
import { SettingsPlaceholder } from './SettingsPlaceholder';
import { SETTINGS_SECTIONS } from './settings-nav-config';

interface SettingsContentProps {
  section: string;
}

export function SettingsContent({ section }: SettingsContentProps) {
  const meta = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];

  return (
    <>
      <SettingsPageHeader title={meta.label} subtitle={meta.description} />
      <SettingsPlaceholder section={section} description="此分区即将上线" />
    </>
  );
}
