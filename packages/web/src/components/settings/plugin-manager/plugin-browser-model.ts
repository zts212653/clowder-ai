import { pluginDescriptionVariants } from '@cat-cafe/shared';
import { pluginManagerText } from './controls/plugin-manager.shell-copy';
import type { PluginScope } from './PluginScopeMenu';
import { installedPluginGroups, type PluginManagerPresentation } from './plugin-manager-attention';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

function matchesSearch(plugin: PluginManagerDesignFixture, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return `${plugin.id} ${plugin.displayName} ${pluginDescriptionVariants(plugin.description).join(' ')} ${plugin.packageName} ${plugin.publisher} ${plugin.capabilities
    .map((capability) => `${capability.name} ${capability.description}`)
    .join(' ')}`
    .toLocaleLowerCase()
    .includes(normalized);
}

export function pluginBrowserModel({
  fixtures,
  presentation,
  locale,
  unavailable,
  hasCatalogHistory,
  scope,
  query,
  availableLimit,
}: {
  fixtures: readonly PluginManagerDesignFixture[];
  presentation: PluginManagerPresentation;
  locale: string;
  unavailable: boolean;
  hasCatalogHistory: boolean;
  scope: PluginScope;
  query: string;
  availableLimit: number;
}) {
  const modern = presentation === 'v2';
  const t = pluginManagerText(locale);
  const managed =
    modern && unavailable
      ? fixtures.map((p) => ({ ...p, actions: p.actions ? { ...p.actions, install: false } : undefined }))
      : fixtures;
  const known = unavailable && !hasCatalogHistory ? managed.filter((p) => p.artifact !== 'absent') : managed;
  const allGroups = installedPluginGroups(known, presentation, locale);
  const attention = allGroups.find((g) => g.kind === 'attention')?.plugins ?? [];
  const counts = {
    all: known.length,
    attention: attention.length,
    installed: known.filter((p) => p.artifact === 'installed').length,
    available: unavailable && !hasCatalogHistory ? null : known.filter((p) => p.artifact === 'absent').length,
  };
  const searched = known.filter((plugin) => matchesSearch(plugin, query));
  const filtered =
    modern && !query.trim()
      ? known.filter(
          (p) =>
            scope === 'all' ||
            (scope === 'attention'
              ? attention.includes(p)
              : scope === 'installed'
                ? p.artifact === 'installed'
                : p.artifact === 'absent'),
        )
      : searched;
  const leadingGroups =
    modern && scope === 'installed' && !query.trim()
      ? [
          {
            kind: 'installed' as const,
            title: t.installed,
            ariaLabel: t.installed,
            plugins: [
              ...attention.filter((p) => p.artifact === 'installed'),
              ...filtered.filter((p) => !attention.includes(p)),
            ],
          },
        ]
      : installedPluginGroups(filtered, presentation, locale).map((g) => ({
          ...g,
          title: modern && g.kind === 'installed' ? '其他已安装' : g.title,
        }));
  const recommendationPool = filtered.filter(
    (plugin) => plugin.artifact === 'absent' && (presentation === 'v2' || plugin.source === 'catalog'),
  );
  const recommendedPlugins = modern || query.trim() ? recommendationPool : recommendationPool.slice(0, availableLimit);
  const hasMore = !modern && !query.trim() && recommendedPlugins.length < recommendationPool.length;
  const otherPlugins = filtered.filter(
    (plugin) => presentation === 'v1' && plugin.artifact === 'absent' && plugin.source !== 'catalog',
  );
  const visible = [...leadingGroups.flatMap((group) => group.plugins), ...recommendationPool, ...otherPlugins];
  return {
    known,
    attention,
    counts,
    filtered,
    leadingGroups,
    recommendationPool,
    recommendedPlugins,
    hasMore,
    otherPlugins,
    visible,
  };
}
