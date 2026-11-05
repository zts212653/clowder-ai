import { validatePluginCatalog } from '@clowder-ai/plugin-contract';
import { OFFICIAL_BUNDLED_CATALOG_ENTRIES } from '../official-catalog.js';
import {
  loadMachinePluginCatalog,
  MachineOfficialPluginCatalog,
  OFFICIAL_PLUGIN_CATALOG_URL,
} from './machine-catalog-provider.js';

export function createHostOfficialPluginCatalog(
  loadCatalog: () => Promise<unknown> = () => loadMachinePluginCatalog(OFFICIAL_PLUGIN_CATALOG_URL),
): MachineOfficialPluginCatalog {
  return new MachineOfficialPluginCatalog({
    loadCatalog,
    validateCatalog: validatePluginCatalog,
    bundledEntries: OFFICIAL_BUNDLED_CATALOG_ENTRIES,
  });
}
