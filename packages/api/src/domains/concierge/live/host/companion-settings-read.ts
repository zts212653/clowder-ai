import { catRegistry } from '@cat-cafe/shared';
import { isCatAvailable } from '../../../../config/cat-config-loader.js';
import type { IConciergeConfigStore } from '../../ConciergeConfigStore.js';
import type { ReadCompanionSettings } from '../../companion-settings.js';
import { resolveLiveCompanionSelection } from '../live-companion-selection.js';

/** Read the companion's plugin configuration, the owner's runtime choices and the current roster; no writes. */
export async function readCompanionSettingsSource(
  store: IConciergeConfigStore,
  readSettings: ReadCompanionSettings,
  userId: string,
) {
  const config = { ...(await store.get(userId)), ...(await readSettings()) };
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
