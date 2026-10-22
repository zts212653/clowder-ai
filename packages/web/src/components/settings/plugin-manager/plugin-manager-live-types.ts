import type { ReactNode } from 'react';
import type { SettingsPageHeaderProps } from '../SettingsPageHeader';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

export interface PluginManagerLiveContentProps {
  presentation?: 'v1' | 'v2';
  pageHeader?: Omit<SettingsPageHeaderProps, 'children'>;
  compatibilityFixtures?: readonly PluginManagerDesignFixture[];
  renderCompatibilityDetail?: (pluginId: string, plugin: PluginManagerDesignFixture) => ReactNode | undefined;
}
