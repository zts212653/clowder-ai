import { SettingsText } from '../primitives/SettingsText';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

const SOURCE_LABELS: Record<PluginManagerDesignFixture['trust'], string> = {
  official: '可信来源 · 插件目录',
  'first-party': '可信来源 · 应用内置',
  unverified: '非可信来源 · 未经插件目录验证',
  unknown: '来源未知 · 缺少安装来源记录',
};

export function PluginSourceLabel({
  trust,
  repositoryName,
}: Pick<PluginManagerDesignFixture, 'trust' | 'repositoryName'>) {
  return (
    <span data-plugin-source-trust={trust} className="mt-0.5 block">
      <SettingsText variant="xs" tone="muted">
        {repositoryName ? `来自 ${repositoryName}` : SOURCE_LABELS[trust]}
      </SettingsText>
    </span>
  );
}
