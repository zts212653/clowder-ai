import { pluginDescriptionVariants } from '@cat-cafe/shared';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

export function matchesPluginSearch(plugin: PluginManagerDesignFixture, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return `${plugin.id} ${plugin.displayName} ${pluginDescriptionVariants(plugin.description).join(' ')} ${plugin.packageName} ${plugin.publisher} ${plugin.capabilities
    .map((capability) => `${capability.name} ${capability.description}`)
    .join(' ')}`
    .toLocaleLowerCase()
    .includes(normalized);
}
