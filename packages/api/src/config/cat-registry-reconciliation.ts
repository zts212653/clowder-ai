import { isDeepStrictEqual } from 'node:util';
import { type CatCafeConfig, type CatConfig, catRegistry } from '@cat-cafe/shared';
import { saveSpan } from '../utils/member-save-diagnostics.js';
import { loadResolvedCatConfig, toAllCatConfigs } from './cat-config-loader.js';
import { resolveProjectTemplatePath } from './project-template-path.js';

// Publication provenance only. The resolver remains the catalog owner; nothing is persisted here.
const publicationChecks = new WeakMap<CatConfig, () => boolean>();

/** Startup and reconciliation publish the same proof with their original resolved source. */
export function registerCatalogSnapshot(
  runtimeCats: Record<string, CatConfig>,
  readCurrent: () => CatCafeConfig,
  configurationTemplatePath?: string,
) {
  const published = structuredClone(runtimeCats);
  const isCurrent = () => isDeepStrictEqual(published, toAllCatConfigs(readCurrent()));
  for (const [id, member] of Object.entries(runtimeCats)) {
    catRegistry.register(id, member, configurationTemplatePath ? { configurationTemplatePath } : undefined);
    publicationChecks.set(member, isCurrent);
  }
}

/** Programmatic entries retain their existing owner; only catalog publications have this proof. */
export function isPublishedCatalogSnapshotCurrent(config: CatConfig | undefined): boolean {
  return !config || (publicationChecks.get(config)?.() ?? true);
}

/** Replace catalog-owned entries, retaining unrelated programmatically registered cats.
 * New objects leave already accepted invocation/Realtime snapshots unchanged.
 */
export function reconcileCatRegistry(projectRoot: string, managedIdsBefore: ReadonlySet<string>) {
  return saveSpan('catalog.reconcile', () => {
    const templatePath = resolveProjectTemplatePath(projectRoot);
    const runtimeCats = toAllCatConfigs(loadResolvedCatConfig(templatePath));
    const extraCats = catRegistry.getAllIds().map((id) => [id, catRegistry.getOrThrow(id)] as const);
    catRegistry.reset();
    registerCatalogSnapshot(
      runtimeCats,
      () => loadResolvedCatConfig(templatePath, { persistMigrations: false }),
      templatePath,
    );
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
