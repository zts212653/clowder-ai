import { SettingsText } from '../primitives/SettingsText';
import { pluginManagerText } from './controls/plugin-manager.shell-copy';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

export function PluginSourceLabel({
  trust,
  repositoryName,
  compact = false,
  locale = 'zh-CN',
  availableVersion,
}: Pick<PluginManagerDesignFixture, 'trust' | 'repositoryName'> & {
  compact?: boolean;
  locale?: string;
  availableVersion?: string | undefined;
}) {
  const t = pluginManagerText(locale);
  const source = repositoryName
    ? t.repository(repositoryName)
    : t.source[trust === 'first-party' ? 'firstParty' : trust];
  const label = availableVersion ? t.updateSource(availableVersion, source) : source;
  return (
    <span
      data-plugin-source-trust={trust}
      className={`mt-0.5 block${compact ? ' truncate text-compact' : ''}`}
      title={compact ? label : undefined}
    >
      <SettingsText variant="xs" tone="muted" className="!text-compact">
        {label}
      </SettingsText>
    </span>
  );
}
