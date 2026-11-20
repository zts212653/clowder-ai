import { catRegistry, type WatcherConfig, type WatcherObserver } from '@cat-cafe/shared';
import { getCatFamily } from '../../../config/cat-config-loader.js';

/** Roster family is canonical; catalog breed metadata also supports installations without a roster. */
export function watcherFamily(catId: string): string | undefined {
  return getCatFamily(catId) ?? catRegistry.tryGet(catId)?.config.breedId;
}

export function watcherUsesOrdinaryContext(config: WatcherConfig): boolean {
  return config.routing !== undefined || config.panel?.enabled === true;
}

/** No family name, provider name or member identity is a routing rule. */
export function watcherRoundMembers(
  config: WatcherConfig,
  workerCatId: string,
  family: (catId: string) => string | undefined = watcherFamily,
): { members: readonly WatcherObserver[]; skipped?: 'same_family' } {
  const routing = config.routing;
  if (!routing) return { members: config.panel?.members ?? [] };
  const primary = routing.primary;
  const primaryFamily = family(primary.catId);
  const sameFamily =
    primary.catId === workerCatId || (primaryFamily !== undefined && primaryFamily === family(workerCatId));
  if (!sameFamily || routing.whenSameFamily.mode === 'primary') return { members: [primary] };
  if (routing.whenSameFamily.mode === 'skip') return { members: [], skipped: 'same_family' };
  return { members: [routing.whenSameFamily.member] };
}

/** Membership for an already authenticated round's output fence; its revision guards stale choices. */
export function configuredWatcherMembers(config: WatcherConfig): readonly WatcherObserver[] {
  if (!config.routing) return config.panel?.enabled ? config.panel.members : [{ catId: config.memberCatId }];
  const { primary, whenSameFamily } = config.routing;
  return whenSameFamily.mode === 'member' ? [primary, whenSameFamily.member] : [primary];
}
