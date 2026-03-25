import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { CatCafeConfig, Roster } from '@cat-cafe/shared';
import { createModuleLogger } from '../infrastructure/logger.js';
import { resolveProjectTemplatePath } from './project-template-path.js';
import { builtinAccountIdForClient, readBootstrapBindingsSync } from './provider-profiles.js';
import type { BootstrapBinding, BuiltinAccountClient } from './provider-profiles.types.js';
import { resolveProviderProfilesRootSync } from './provider-profiles-root.js';

const CAT_CAFE_DIR = '.cat-cafe';
const META_FILENAME = 'provider-profiles.json';
const CAT_CATALOG_FILENAME = 'cat-catalog.json';
const log = createModuleLogger('cat-catalog-store');

function safePath(projectRoot: string, ...segments: string[]): string {
  const root = resolve(projectRoot);
  const normalized = resolve(root, ...segments);
  const rel = relative(root, normalized);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Path escapes project root: ${normalized}`);
  }
  return normalized;
}

function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, 'utf-8');
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failures.
    }
    throw error;
  }
}

function providerToBootstrapClient(provider: unknown): BuiltinAccountClient | null {
  switch (provider) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
    case 'relayclaw':
      return 'openai';
    case 'google':
      return 'google';
    case 'dare':
      return 'dare';
    case 'opencode':
      return 'opencode';
    default:
      return null;
  }
}

function trimBinding(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveExplicitVariantAccountRef(variant: Record<string, unknown>): string | null {
  return trimBinding(variant.providerProfileId) ?? trimBinding(variant.accountRef);
}

function readProfileModelsSync(projectRoot: string, accountRef: string): string[] | null {
  try {
    const storageRoot = resolveProviderProfilesRootSync(projectRoot);
    const metaPath = resolve(storageRoot, CAT_CAFE_DIR, META_FILENAME);
    if (!existsSync(metaPath)) return null;
    const raw = JSON.parse(readFileSync(metaPath, 'utf-8'));
    const providers = raw?.providers ?? raw?.profiles ?? [];
    const profile = (providers as Array<{ id?: string; models?: string[] }>).find((p) => p.id === accountRef);
    return profile?.models ?? null;
  } catch {
    return null;
  }
}

function cloneWithAccountRef(
  variant: Record<string, unknown>,
  accountRef: string,
  options?: { explicit?: boolean; profileModels?: string[] | null },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...variant, accountRef };
  if (options?.explicit) {
    next.providerProfileId = accountRef;
  } else {
    delete (next as { providerProfileId?: unknown }).providerProfileId;
  }
  // If the variant's defaultModel is not in the bound profile's model list,
  // fall back to the first available model from the profile.
  const models = options?.profileModels;
  if (models && models.length > 0) {
    const currentModel = typeof next.defaultModel === 'string' ? next.defaultModel.trim() : '';
    if (!currentModel || !models.includes(currentModel)) {
      next.defaultModel = models[0];
    }
  }
  return next;
}

function resolveSelectedVariants(
  breed: Record<string, unknown>,
  binding: BootstrapBinding | undefined,
  projectRoot: string,
): Record<string, unknown>[] {
  if (!binding || binding.mode === 'skip' || binding.enabled === false) return [];
  const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
  const defaultVariantId = typeof breed.defaultVariantId === 'string' ? breed.defaultVariantId : undefined;
  const accountRef = binding.accountRef?.trim();
  if (!accountRef) return [];

  if (binding.mode === 'api_key') {
    const selected =
      variants.find((variant) => variant.id === defaultVariantId) ??
      variants.find((variant) => providerToBootstrapClient(variant.provider) != null);
    if (!selected) return [];
    const explicitAccountRef = resolveExplicitVariantAccountRef(selected);
    const effectiveRef = explicitAccountRef ?? accountRef;
    const profileModels = readProfileModelsSync(projectRoot, effectiveRef);
    return [
      cloneWithAccountRef(selected, effectiveRef, {
        explicit: explicitAccountRef != null,
        profileModels,
      }),
    ];
  }

  return variants.map((variant) => {
    const explicitAccountRef = resolveExplicitVariantAccountRef(variant);
    return cloneWithAccountRef(variant, explicitAccountRef ?? accountRef, {
      explicit: explicitAccountRef != null,
    });
  });
}

function collectBreedCatIds(breed: Record<string, unknown>): string[] {
  const breedCatId = typeof breed.catId === 'string' ? breed.catId : null;
  const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
  const collected = new Set<string>();
  for (const variant of variants) {
    const catId = typeof variant.catId === 'string' ? variant.catId : breedCatId;
    if (catId) collected.add(catId);
  }
  return [...collected];
}

function fallbackAccountRefForClient(client: BuiltinAccountClient, binding: BootstrapBinding | undefined): string {
  return binding?.accountRef?.trim() || builtinAccountIdForClient(client);
}

function readSeedMetadata(projectRoot: string): {
  explicitSeedAccountRefs: Map<string, string>;
  seedCatIdsByClient: Map<BuiltinAccountClient, Set<string>>;
} {
  const explicitSeedAccountRefs = new Map<string, string>();
  const seedCatIdsByClient = new Map<BuiltinAccountClient, Set<string>>();

  try {
    const template = JSON.parse(readFileSync(resolveProjectTemplatePath(projectRoot), 'utf-8')) as CatCafeConfig;
    for (const breed of template.breeds as unknown as Record<string, unknown>[]) {
      const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
      for (const variant of variants) {
        const client = providerToBootstrapClient(variant.provider);
        if (!client) continue;
        const catId =
          typeof variant.catId === 'string' ? variant.catId : typeof breed.catId === 'string' ? breed.catId : null;
        if (!catId) continue;
        const clientSeedCatIds = seedCatIdsByClient.get(client) ?? new Set<string>();
        clientSeedCatIds.add(catId);
        seedCatIdsByClient.set(client, clientSeedCatIds);

        const explicitAccountRef = resolveExplicitVariantAccountRef(variant);
        if (explicitAccountRef) explicitSeedAccountRefs.set(catId, explicitAccountRef);
      }
    }
  } catch {
    // Keep migration best-effort when the template is unavailable.
  }

  return { explicitSeedAccountRefs, seedCatIdsByClient };
}

function resolveLegacySeedBindingBackfill(
  projectRoot: string,
  catalog: CatCafeConfig,
  _bootstrapBindings: Record<string, BootstrapBinding | undefined>,
): Map<string, string> {
  const { explicitSeedAccountRefs, seedCatIdsByClient } = readSeedMetadata(projectRoot);
  const backfill = new Map<string, string>();
  const observedSeedBindings = new Map<BuiltinAccountClient, Array<{ catId: string; accountRef: string }>>();

  for (const breed of catalog.breeds as unknown as Record<string, unknown>[]) {
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      const client = providerToBootstrapClient(variant.provider);
      if (!client) continue;

      const catId =
        typeof variant.catId === 'string' ? variant.catId : typeof breed.catId === 'string' ? breed.catId : null;
      if (!catId) continue;

      const providerProfileId = trimBinding(variant.providerProfileId);
      const accountRef = trimBinding(variant.accountRef);
      if (providerProfileId || !accountRef) continue;

      const templateExplicitAccountRef = explicitSeedAccountRefs.get(catId);
      if (templateExplicitAccountRef && templateExplicitAccountRef === accountRef) {
        backfill.set(catId, accountRef);
        continue;
      }

      if (!seedCatIdsByClient.get(client)?.has(catId)) continue;
      const bindings = observedSeedBindings.get(client) ?? [];
      bindings.push({ catId, accountRef });
      observedSeedBindings.set(client, bindings);
    }
  }

  for (const [client, bindings] of observedSeedBindings) {
    if (bindings.length < 2) continue;
    const uniqueAccountRefs = new Set(bindings.map((binding) => binding.accountRef));
    if (uniqueAccountRefs.size <= 1) continue;

    const inheritedAccountRef = builtinAccountIdForClient(client);
    if (!uniqueAccountRefs.has(inheritedAccountRef)) continue;
    for (const binding of bindings) {
      if (binding.accountRef !== inheritedAccountRef) {
        backfill.set(binding.catId, binding.accountRef);
      }
    }
  }

  return backfill;
}

function migrateExistingCatalogBindings(
  projectRoot: string,
  catalog: CatCafeConfig,
): { catalog: CatCafeConfig; dirty: boolean } {
  const bootstrapBindings = readBootstrapBindingsSync(projectRoot);
  const legacySeedBindingBackfill = resolveLegacySeedBindingBackfill(projectRoot, catalog, bootstrapBindings);
  let dirty = false;
  const nextCatalog = structuredClone(catalog) as CatCafeConfig;

  for (const breed of nextCatalog.breeds as unknown as Record<string, unknown>[]) {
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      const client = providerToBootstrapClient(variant.provider);
      if (!client) continue;
      const catId =
        typeof variant.catId === 'string' ? variant.catId : typeof breed.catId === 'string' ? breed.catId : null;
      const explicitProviderProfileId = trimBinding(variant.providerProfileId);
      const existingAccountRef = typeof variant.accountRef === 'string' ? variant.accountRef.trim() : '';
      const legacyExplicitAccountRef = catId ? legacySeedBindingBackfill.get(catId) : undefined;
      if (!explicitProviderProfileId && existingAccountRef && legacyExplicitAccountRef === existingAccountRef) {
        variant.providerProfileId = existingAccountRef;
        dirty = true;
        continue;
      }
      if (existingAccountRef) continue;
      if (explicitProviderProfileId) {
        variant.accountRef = explicitProviderProfileId;
        dirty = true;
        continue;
      }
      const nextAccountRef = fallbackAccountRefForClient(client, bootstrapBindings[client]);
      if (!nextAccountRef) continue;
      variant.accountRef = nextAccountRef;
      dirty = true;
    }
  }

  return { catalog: nextCatalog, dirty };
}

function filterBootstrapCatalog(template: CatCafeConfig, projectRoot: string): CatCafeConfig {
  const bootstrapBindings = readBootstrapBindingsSync(projectRoot);
  const selectedBreeds: Record<string, unknown>[] = [];
  const selectedCatIds = new Set<string>();

  for (const rawBreed of template.breeds as unknown as Record<string, unknown>[]) {
    const variants = Array.isArray(rawBreed.variants) ? (rawBreed.variants as Record<string, unknown>[]) : [];
    const firstClient = variants.map((variant) => providerToBootstrapClient(variant.provider)).find(Boolean) ?? null;
    if (!firstClient) {
      selectedBreeds.push(rawBreed);
      for (const catId of collectBreedCatIds(rawBreed)) selectedCatIds.add(catId);
      continue;
    }
    const binding = bootstrapBindings[firstClient];
    if (!binding || binding.mode === 'skip' || binding.enabled === false) {
      selectedBreeds.push(rawBreed);
      for (const catId of collectBreedCatIds(rawBreed)) selectedCatIds.add(catId);
      continue;
    }
    const selectedVariants = resolveSelectedVariants(rawBreed, binding, projectRoot);
    if (selectedVariants.length === 0) {
      selectedBreeds.push(rawBreed);
      for (const catId of collectBreedCatIds(rawBreed)) selectedCatIds.add(catId);
      continue;
    }
    const nextBreed: Record<string, unknown> = {
      ...rawBreed,
      variants: selectedVariants,
      defaultVariantId: selectedVariants.some((variant) => variant.id === rawBreed.defaultVariantId)
        ? rawBreed.defaultVariantId
        : selectedVariants[0]?.id,
    };
    selectedBreeds.push(nextBreed);
    for (const variant of selectedVariants) {
      const catId = typeof variant.catId === 'string' ? variant.catId : rawBreed.catId;
      if (typeof catId === 'string' && catId) selectedCatIds.add(catId);
    }
  }

  const templateRoster = 'roster' in template ? template.roster : {};
  const filteredRoster = Object.fromEntries(
    Object.entries((templateRoster ?? {}) as Record<string, unknown>).filter(([catId]) => selectedCatIds.has(catId)),
  );

  if ('roster' in template) {
    return {
      ...template,
      breeds: selectedBreeds as unknown as typeof template.breeds,
      roster: filteredRoster as Roster,
    };
  }

  return {
    ...template,
    breeds: selectedBreeds as unknown as typeof template.breeds,
  };
}

function reconcileCatalogWithSourceCatalog(
  existingCatalog: CatCafeConfig,
  sourceCatalog: CatCafeConfig,
): { catalog: CatCafeConfig; dirty: boolean } {
  const nextCatalog = structuredClone(existingCatalog) as CatCafeConfig & { roster?: Roster };
  let dirty = false;

  const existingBreeds = nextCatalog.breeds as unknown as Array<Record<string, unknown>>;
  const existingBreedById = new Map(
    existingBreeds
      .filter((breed) => typeof breed.id === 'string' && breed.id.length > 0)
      .map((breed) => [breed.id as string, breed]),
  );

  for (const sourceBreed of sourceCatalog.breeds as unknown as Array<Record<string, unknown>>) {
    const sourceBreedId = typeof sourceBreed.id === 'string' ? sourceBreed.id : null;
    if (!sourceBreedId) continue;
    const existingBreed = existingBreedById.get(sourceBreedId);
    if (!existingBreed) {
      existingBreeds.push(structuredClone(sourceBreed));
      dirty = true;
      continue;
    }

    const existingVariants = Array.isArray(existingBreed.variants)
      ? (existingBreed.variants as Array<Record<string, unknown>>)
      : [];
    const existingVariantIds = new Set(
      existingVariants
        .map((variant) => (typeof variant.id === 'string' ? variant.id : null))
        .filter((id): id is string => id !== null),
    );
    const sourceVariants = Array.isArray(sourceBreed.variants)
      ? (sourceBreed.variants as Array<Record<string, unknown>>)
      : [];
    for (const sourceVariant of sourceVariants) {
      const sourceVariantId = typeof sourceVariant.id === 'string' ? sourceVariant.id : null;
      if (!sourceVariantId || existingVariantIds.has(sourceVariantId)) continue;
      existingVariants.push(structuredClone(sourceVariant));
      existingVariantIds.add(sourceVariantId);
      dirty = true;
    }
    if (existingVariants.length > 0) {
      existingBreed.variants = existingVariants;
    }
  }

  if ('roster' in sourceCatalog) {
    const nextRoster = { ...(('roster' in nextCatalog ? nextCatalog.roster : {}) ?? {}) } as Roster;
    for (const [catId, rosterEntry] of Object.entries(sourceCatalog.roster ?? {})) {
      if (nextRoster[catId]) continue;
      nextRoster[catId] = structuredClone(rosterEntry);
      dirty = true;
    }
    if ('roster' in nextCatalog) {
      nextCatalog.roster = nextRoster;
    } else {
      nextCatalog.roster = nextRoster;
    }
  }

  return { catalog: nextCatalog as CatCafeConfig, dirty };
}

export function resolveCatCatalogPath(projectRoot: string): string {
  return safePath(projectRoot, CAT_CAFE_DIR, CAT_CATALOG_FILENAME);
}

export function readCatCatalogRaw(projectRoot: string): string | null {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  if (!existsSync(catalogPath)) return null;
  const raw = readFileSync(catalogPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as CatCafeConfig;
    const migrated = migrateExistingCatalogBindings(projectRoot, parsed);
    if (migrated.dirty) {
      const nextRaw = `${JSON.stringify(migrated.catalog, null, 2)}\n`;
      writeFileAtomic(catalogPath, nextRaw);
      return nextRaw;
    }
  } catch {
    // Leave invalid JSON handling to the loader so callers see the original parse error.
  }
  return raw;
}

export function readCatCatalog(projectRoot: string): CatCafeConfig | null {
  const raw = readCatCatalogRaw(projectRoot);
  if (raw === null) return null;
  return JSON.parse(raw) as CatCafeConfig;
}

export function bootstrapCatCatalog(projectRoot: string, templatePath: string): string {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  if (existsSync(catalogPath)) {
    const sourcePath = existsSync(resolve(projectRoot, 'cat-config.json')) ? resolve(projectRoot, 'cat-config.json') : templatePath;
    try {
      const existingCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as CatCafeConfig;
      const sourceCatalog = JSON.parse(readFileSync(sourcePath, 'utf-8')) as CatCafeConfig;
      const reconciled = reconcileCatalogWithSourceCatalog(existingCatalog, sourceCatalog);
      if (reconciled.dirty) {
        writeFileAtomic(catalogPath, `${JSON.stringify(reconciled.catalog, null, 2)}\n`);
      }
    } catch (err) {
      log.warn({ err, projectRoot, catalogPath }, 'catalog reconciliation failed');
    }
    readCatCatalogRaw(projectRoot);
    return catalogPath;
  }

  // Prefer cat-config.json (real runtime config with owner data) over cat-template.json
  // for bootstrapping the catalog. The template is only used for fresh installations
  // where cat-config.json doesn't exist (e.g. new clones from the open-source repo).
  const legacyConfigPath = resolve(projectRoot, 'cat-config.json');
  const sourcePath = existsSync(legacyConfigPath) ? legacyConfigPath : templatePath;
  const template = JSON.parse(readFileSync(sourcePath, 'utf-8')) as CatCafeConfig;
  const runtimeCatalog = filterBootstrapCatalog(template, projectRoot);
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileAtomic(catalogPath, `${JSON.stringify(runtimeCatalog, null, 2)}\n`);
  return catalogPath;
}

export function writeCatCatalog(projectRoot: string, catalog: CatCafeConfig): string {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return catalogPath;
}
