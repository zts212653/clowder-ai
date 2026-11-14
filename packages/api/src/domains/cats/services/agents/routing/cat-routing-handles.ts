import {
  buildCatMentionHandles,
  type CatId,
  catRegistry,
  coCreatorNickname,
  type MentionHandle,
} from '@cat-cafe/shared';
import { getCoCreatorConfig, getCoCreatorMentionPatterns } from '../../../../../config/cat-config-loader.js';

type PluginMention = { readonly id: string; readonly alias: string };

export function getCatRoutingHandles(plugins: readonly PluginMention[]): MentionHandle<CatId>[] {
  const pluginHandles = plugins.map(({ id, alias }) => ({ catId: id as CatId, pattern: `@${alias.toLowerCase()}` }));
  const reserved = [...getCoCreatorMentionPatterns(), ...pluginHandles.map(({ pattern }) => pattern)];
  const ownerNickname = coCreatorNickname(getCoCreatorConfig())?.trim().replace(/^@/, '');
  if (ownerNickname) reserved.push(`@${ownerNickname}`);

  const cats = Object.entries(catRegistry.getAllConfigs()).map(([id, config]) => ({
    id: id as CatId,
    mentionPatterns: config.mentionPatterns,
  }));
  return [...buildCatMentionHandles(cats, reserved), ...pluginHandles];
}
