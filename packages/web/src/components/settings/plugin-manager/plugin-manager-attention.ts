import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

export type PluginManagerPresentation = 'v1' | 'v2';

export function installedPluginGroups(
  plugins: readonly PluginManagerDesignFixture[],
  presentation: PluginManagerPresentation,
) {
  const attention = plugins.filter((plugin) =>
    presentation === 'v2'
      ? pluginAttentionReason(plugin) !== undefined
      : plugin.artifact !== 'installed' && plugin.artifact !== 'absent',
  );
  const attentionSet = new Set(attention);
  const installed = plugins.filter((plugin) => plugin.artifact === 'installed' && !attentionSet.has(plugin));
  const groups = {
    attention: { kind: 'attention' as const, title: '需要处理', ariaLabel: '需要处理的插件', plugins: attention },
    installed: { kind: 'installed' as const, title: '已安装', ariaLabel: '已安装插件', plugins: installed },
  };
  return presentation === 'v2' ? [groups.attention, groups.installed] : [groups.installed, groups.attention];
}

const artifactReasons = { staged: '安装尚未完成', verified: '安装尚未完成', quarantined: '安装包已隔离' };
const configReasons = { incomplete: '配置尚未完成', invalid: '配置无效' };
const authReasons = { expired: '授权已过期', error: '授权失败' };
const liveReasons = { degraded: '运行受限', crashed: '运行进程已退出' };

/** Classify current state, not a historical diagnostic or an absent candidate's default config. */
export function pluginAttentionReason(plugin: PluginManagerDesignFixture): string | undefined {
  if (plugin.artifact === 'absent') return undefined;
  if (plugin.artifact !== 'installed') return artifactReasons[plugin.artifact];
  if (plugin.activationFailed === true) return plugin.diagnostic?.trim() || '插件运行操作失败';
  if (plugin.config !== 'ready') return configReasons[plugin.config];
  if (plugin.auth === 'expired' || plugin.auth === 'error') return authReasons[plugin.auth];
  if (plugin.live === 'degraded' || plugin.live === 'crashed') {
    return plugin.diagnostic?.trim() || liveReasons[plugin.live];
  }
  if (plugin.intent !== 'enabled') return undefined;
  if (plugin.auth === 'disconnected') return '尚未连接授权';
  if (plugin.auth === 'pending') return '等待完成授权';
  if (plugin.live === 'stopped') return '已启用，但尚未运行';
  return undefined;
}
