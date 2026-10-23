import { pluginManagerText } from './controls/plugin-manager.shell-copy';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

export type PluginManagerPresentation = 'v1' | 'v2';

export function installedPluginGroups(
  plugins: readonly PluginManagerDesignFixture[],
  presentation: PluginManagerPresentation,
  locale = 'zh-CN',
) {
  const t = pluginManagerText(locale);
  const attention = plugins.filter((plugin) =>
    presentation === 'v2'
      ? pluginAttentionReason(plugin) !== undefined || pluginHasUpdate(plugin)
      : plugin.artifact !== 'installed' && plugin.artifact !== 'absent',
  );
  const attentionSet = new Set(attention);
  const installed = plugins.filter((plugin) => plugin.artifact === 'installed' && !attentionSet.has(plugin));
  const groups = {
    attention: {
      kind: 'attention' as const,
      title: t.attention,
      ariaLabel: locale.startsWith('en') ? t.attention : '需要处理的插件',
      plugins: attention,
    },
    installed: {
      kind: 'installed' as const,
      title: t.installed,
      ariaLabel: locale.startsWith('en') ? t.installed : '已安装插件',
      plugins: installed,
    },
  };
  return presentation === 'v2' ? [groups.attention, groups.installed] : [groups.installed, groups.attention];
}

/** The Host must advertise the action; a different version alone is not permission. */
export function pluginHasUpdate(plugin: PluginManagerDesignFixture): boolean {
  return (
    plugin.artifact === 'installed' &&
    plugin.installedVersion !== null &&
    plugin.availableVersion !== plugin.installedVersion &&
    (plugin.actions?.install ?? true)
  );
}

/** Classify current state, not a historical diagnostic or an absent candidate's default config. */
export function pluginAttentionReason(plugin: PluginManagerDesignFixture, locale = 'zh-CN'): string | undefined {
  const t = pluginManagerText(locale);
  // Summarize the current state; unmodified diagnostics remain in details/title.
  if (plugin.artifact === 'absent') return undefined;
  if (plugin.artifact !== 'installed') return plugin.artifact === 'quarantined' ? t.quarantined : t.staged;
  if (plugin.actions?.blockingReasons.includes('package-incompatible')) return t.incompatible;
  if (plugin.activationFailed === true) return t.failed;
  if (plugin.config !== 'ready') return plugin.config === 'invalid' ? t.invalid : t.incomplete;
  if (plugin.auth === 'expired' || plugin.auth === 'error') return plugin.auth === 'expired' ? t.expired : t.authError;
  if (plugin.live === 'degraded' || plugin.live === 'crashed') {
    return plugin.live === 'degraded' ? t.degraded : t.failed;
  }
  if (plugin.intent !== 'enabled') return undefined;
  if (plugin.auth === 'disconnected') return t.disconnected;
  if (plugin.auth === 'pending') return t.pending;
  if (plugin.live === 'stopped') return locale.startsWith('en') ? t.stopped : '已启用，但尚未运行';
  return undefined;
}

export function pluginStatusLabel(plugin: PluginManagerDesignFixture, locale: string): string {
  const t = pluginManagerText(locale);
  if (plugin.artifact === 'absent') return t.notInstalled;
  return (
    pluginAttentionReason(plugin, locale) ??
    (plugin.intent !== 'enabled'
      ? t.disabled
      : plugin.live === 'running'
        ? t.ready
        : plugin.live === 'starting'
          ? t.starting
          : t.stopped)
  );
}
