import { buildCatMentionHandles, type CatId, catRegistry, reservedCoCreatorMentionHandles } from '@cat-cafe/shared';
import { getCoCreatorConfig } from '../../../../../config/cat-config-loader.js';

export type PluginMention = { readonly id: string; readonly alias: string };

export function reservedOwnerMentionHandles(): string[] {
  return reservedCoCreatorMentionHandles(getCoCreatorConfig());
}

export function getCatRoutingHandles(
  plugins: readonly PluginMention[] = [],
  onCollision?: (catId: string, handle: string, holder?: string) => void,
): { catId: CatId; pattern: string }[] {
  const pluginHandles = plugins.map(({ id, alias }) => ({ catId: id, pattern: `@${alias.toLowerCase()}` }));
  const memberHandles = buildCatMentionHandles(
    Object.entries(catRegistry.getAllConfigs()).map(([id, config]) => ({
      id,
      mentionPatterns: config.mentionPatterns ?? [],
    })),
    [...reservedOwnerMentionHandles(), ...pluginHandles.map(({ pattern }) => pattern)],
    onCollision,
  );
  return [...memberHandles, ...pluginHandles].map(({ catId, pattern }) => ({ catId: catId as CatId, pattern }));
}
