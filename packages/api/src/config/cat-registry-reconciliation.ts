import { catRegistry } from '@cat-cafe/shared';
import { saveSpan } from '../utils/member-save-diagnostics.js';
import { loadResolvedCatConfig, toAllCatConfigs } from './cat-config-loader.js';
import { resolveProjectTemplatePath } from './project-template-path.js';

/** Replace catalog-owned entries, retaining unrelated programmatically registered cats.
 * New objects leave already accepted invocation/Realtime snapshots unchanged.
 */
export function reconcileCatRegistry(projectRoot: string, managedIdsBefore: ReadonlySet<string>) {
  return saveSpan('catalog.reconcile', () => {
    const templatePath = resolveProjectTemplatePath(projectRoot);
    const runtimeCats = toAllCatConfigs(loadResolvedCatConfig(templatePath));
    const extraCats = catRegistry.getAllIds().map((id) => [id, catRegistry.getOrThrow(id)] as const);
    catRegistry.reset();
    for (const [id, config] of Object.entries(runtimeCats))
      catRegistry.register(id, config, { configurationTemplatePath: templatePath });
    for (const [id, entry] of extraCats) {
      if (!runtimeCats[id] && !managedIdsBefore.has(id))
        catRegistry.register(
          id,
          entry.config,
          entry.configurationTemplatePath ? { configurationTemplatePath: entry.configurationTemplatePath } : undefined,
        );
    }
    return catRegistry.getAllConfigs();
  });
}
