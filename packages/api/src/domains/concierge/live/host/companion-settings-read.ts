import { catRegistry } from '@cat-cafe/shared';
import { isCatAvailable } from '../../../../config/cat-config-loader.js';
import type { IConciergeConfigStore } from '../../ConciergeConfigStore.js';
import { resolveLiveCompanionSelection } from '../live-companion-selection.js';

/** Read the original configuration and current roster; no default substitution or writes. */
export async function readCompanionSettingsSource(store: IConciergeConfigStore, userId: string) {
  if (!store.getSaved) return { status: 'unavailable' as const, reason: 'host_upgrade_required' as const };
  const config = await store.getSaved(userId);
  const cats = Object.values(catRegistry.getAllConfigs());
  const availableCats = cats.filter((cat) => isCatAvailable(cat.id));
  const canSelect = (catId: string): boolean => {
    try {
      resolveLiveCompanionSelection({ ...config, dutyCatProfileId: catId }, availableCats);
      return true;
    } catch {
      return false;
    }
  };
  return {
    status: 'available' as const,
    config,
    companions: cats.map((cat) => ({
      catProfileId: cat.id,
      displayName: cat.nickname?.trim() || cat.displayName,
      available: canSelect(cat.id),
    })),
    selectedCompanionStatus: canSelect(config.dutyCatProfileId) ? ('available' as const) : ('unavailable' as const),
  };
}
