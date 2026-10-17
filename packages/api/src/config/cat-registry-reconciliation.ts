import { catRegistry } from '@cat-cafe/shared';
import { saveSpan } from '../utils/member-save-diagnostics.js';
import { loadResolvedCatConfig, toAllCatConfigs } from './cat-config-loader.js';
import { resolveProjectTemplatePath } from './project-template-path.js';

/** Replace catalog-owned entries, retaining unrelated programmatically registered cats.
 * New objects leave already accepted invocation/Realtime snapshots unchanged.
 */
export function reconcileCatRegistry(projectRoot: string, managedIdsBefore: ReadonlySet<string>) {
  return saveSpan('catalog.reconcile', () => {
    const runtimeCats = toAllCatConfigs(loadResolvedCatConfig(resolveProjectTemplatePath(projectRoot)));
    const extraCats = catRegistry.getAllConfigs();
    catRegistry.reset();
    for (const [id, config] of Object.entries(runtimeCats)) catRegistry.register(id, config);
    for (const [id, config] of Object.entries(extraCats)) {
      if (!runtimeCats[id] && !managedIdsBefore.has(id)) catRegistry.register(id, config);
    }
    return catRegistry.getAllConfigs();
  });
}
