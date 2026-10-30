import { isDeepStrictEqual } from 'node:util';
import { type CatCafeConfig, type CatConfig, catRegistry } from '@cat-cafe/shared';
import { saveSpan } from '../utils/member-save-diagnostics.js';
import { loadResolvedCatConfig, toAllCatConfigs } from './cat-config-loader.js';
import { resolveProjectTemplatePath } from './project-template-path.js';

// Publication provenance only. The resolver remains the catalog owner; nothing is persisted here.
const publicationChecks = new WeakMap<CatConfig, () => boolean>();

/** Startup and reconciliation publish the same proof with their original resolved source. */
export function registerCatalogSnapshot(runtimeCats: Record<string, CatConfig>, readCurrent: () => CatCafeConfig) {
  const published = structuredClone(runtimeCats);
  const isCurrent = () => isDeepStrictEqual(published, toAllCatConfigs(readCurrent()));
  for (const [id, member] of Object.entries(runtimeCats)) {
    catRegistry.register(id, member);
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
    const extraCats = catRegistry.getAllConfigs();
    catRegistry.reset();
    registerCatalogSnapshot(runtimeCats, () => loadResolvedCatConfig(templatePath, { persistMigrations: false }));
    for (const [id, config] of Object.entries(extraCats)) {
      if (!runtimeCats[id] && !managedIdsBefore.has(id)) catRegistry.register(id, config);
    }
    return catRegistry.getAllConfigs();
  });
}
