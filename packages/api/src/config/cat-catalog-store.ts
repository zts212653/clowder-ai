import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { CatCafeConfig, ClientId } from '@cat-cafe/shared';
import { builtinAccountIdForClient, resolveBuiltinClientForProvider } from './account-resolver.js';

const CONFIG_SUBDIR = '.cat-cafe';
const CAT_CATALOG_FILENAME = 'cat-catalog.json';

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

/** clowder-ai#340 P5: ClientId values — used to detect old `provider` field holding a clientId. */
const CLIENT_ID_VALUES = new Set(['anthropic', 'openai', 'google', 'kimi', 'dare', 'antigravity', 'opencode', 'a2a']);

function collectCatIds(config: CatCafeConfig): Set<string> {
  const catIds = new Set<string>();
  for (const breed of config.breeds as unknown as Record<string, unknown>[]) {
    const breedCatId = typeof breed.catId === 'string' ? breed.catId : '';
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      const catId = typeof variant.catId === 'string' ? variant.catId : breedCatId;
      if (catId) catIds.add(catId);
    }
  }
  return catIds;
}

function readSeedCatIds(templatePath: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(templatePath, 'utf-8')) as CatCafeConfig;
    return collectCatIds(migrateCatalogVariants(parsed).catalog);
  } catch {
    return new Set();
  }
}

/**
 * clowder-ai#340: One-time catalog variant migration — rewrites file on disk then never runs again.
 *   1. old `provider` (clientId value) → `clientId` (P5 field rename)
 *   2. old `ocProviderName` → `provider` (P5 field rename)
 *   3. old `providerProfileId` → `accountRef` (P5 field rename)
 * Bootstrap-only default bindings are handled separately in applyBootstrapDefaultAccountRefs().
 */
function migrateCatalogVariants(catalog: CatCafeConfig): { catalog: CatCafeConfig; dirty: boolean } {
  let dirty = false;
  const next = structuredClone(catalog) as CatCafeConfig;

  for (const breed of next.breeds as unknown as Record<string, unknown>[]) {
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      // P5 step 1: old `provider` holding a ClientId value → `clientId`
      if (typeof variant.provider === 'string' && CLIENT_ID_VALUES.has(variant.provider)) {
        if (!variant.clientId) {
          variant.clientId = variant.provider;
          delete variant.provider;
          dirty = true;
        } else if (variant.clientId === variant.provider) {
          // Redundant provider (same as clientId). Only delete if ocProviderName
          // needs to take its place; otherwise keep it so template merge can't
          // leak a stale provider from the base config.
          if (typeof variant.ocProviderName === 'string') {
            delete variant.provider;
            dirty = true;
          }
        }
      }

      // P5 step 2: old `ocProviderName` → `provider`
      if (typeof variant.ocProviderName === 'string' && variant.provider === undefined) {
        variant.provider = variant.ocProviderName;
        delete variant.ocProviderName;
        dirty = true;
      }

      const client = resolveBuiltinClientForProvider((variant.clientId ?? variant.provider) as ClientId);
      if (!client) continue;

      const existingAccountRef = typeof variant.accountRef === 'string' ? variant.accountRef.trim() : '';
      const legacyProfileId = typeof variant.providerProfileId === 'string' ? variant.providerProfileId.trim() : '';

      // P5 step 3: providerProfileId → accountRef
      if (legacyProfileId && !existingAccountRef) {
        variant.accountRef = legacyProfileId;
        delete variant.providerProfileId;
        dirty = true;
        continue;
      }
      if (legacyProfileId) {
        delete variant.providerProfileId;
        dirty = true;
      }

      // clowder-ai#340: Do NOT backfill accountRef for unbound runtime variants.
      // Runtime catalog entries are authoritative; missing accountRef stays missing
      // until the user explicitly binds one in the editor.
    }
  }

  return { catalog: next, dirty };
}

function applyBootstrapDefaultAccountRefs(catalog: CatCafeConfig, seedCatIds: ReadonlySet<string>): CatCafeConfig {
  const next = structuredClone(catalog) as CatCafeConfig;

  for (const breed of next.breeds as unknown as Record<string, unknown>[]) {
    const breedCatId = typeof breed.catId === 'string' ? breed.catId : '';
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      if (variant.source !== 'seed' && variant.source !== 'runtime') {
        const catId = typeof variant.catId === 'string' ? variant.catId : breedCatId;
        variant.source = catId && seedCatIds.has(catId) ? 'seed' : 'runtime';
      }

      const existingAccountRef = typeof variant.accountRef === 'string' ? variant.accountRef.trim() : '';
      if (existingAccountRef) continue;
      const catId = typeof variant.catId === 'string' ? variant.catId : breedCatId;
      if (!catId || !seedCatIds.has(catId)) continue;

      const client = resolveBuiltinClientForProvider((variant.clientId ?? variant.provider) as ClientId);
      if (!client) continue;

      variant.accountRef = builtinAccountIdForClient(client);
    }
  }

  return next;
}

/** One-time migration: stamp `source` on variants written before #441. Idempotent.
 *  Only stamps source — does NOT touch accountRef (existing unbound variants stay unbound). */
function backfillVariantSource(catalogPath: string, templatePath: string): void {
  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf-8');
  } catch {
    return;
  }
  const catalog = JSON.parse(raw) as CatCafeConfig;
  const next = structuredClone(catalog) as CatCafeConfig;
  let dirty = false;
  const seedCatIds = readSeedCatIds(templatePath);
  for (const breed of next.breeds as unknown as Record<string, unknown>[]) {
    const breedCatId = typeof breed.catId === 'string' ? breed.catId : '';
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      if (variant.source !== 'seed' && variant.source !== 'runtime') {
        const catId = typeof variant.catId === 'string' ? variant.catId : breedCatId;
        variant.source = catId && seedCatIds.has(catId) ? 'seed' : 'runtime';
        dirty = true;
      }
    }
  }
  if (!dirty) return;
  writeFileAtomic(catalogPath, `${JSON.stringify(next, null, 2)}\n`);
}

export function resolveCatCatalogPath(projectRoot: string): string {
  return safePath(projectRoot, CONFIG_SUBDIR, CAT_CATALOG_FILENAME);
}

export function readCatCatalogRaw(projectRoot: string): string | null {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  if (!existsSync(catalogPath)) return null;
  const raw = readFileSync(catalogPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as CatCafeConfig;
    const migrated = migrateCatalogVariants(parsed);
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

function readBootstrapSourceConfig(
  projectRoot: string,
  templatePath: string,
): { catalog: CatCafeConfig; sourcePath: string } {
  const legacyConfigPath = safePath(projectRoot, 'cat-config.json');
  const sourcePath = existsSync(legacyConfigPath) ? legacyConfigPath : templatePath;
  return {
    catalog: JSON.parse(readFileSync(sourcePath, 'utf-8')) as CatCafeConfig,
    sourcePath,
  };
}

export function bootstrapCatCatalog(projectRoot: string, templatePath: string): string {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  if (existsSync(catalogPath)) {
    readCatCatalogRaw(projectRoot);
    // Backfill source on existing catalogs written before #441.
    backfillVariantSource(catalogPath, templatePath);
    return catalogPath;
  }

  // Bootstrap must preserve legacy project customizations when upgrading from
  // installs that still have cat-config.json but no runtime catalog yet.
  const { catalog: template, sourcePath } = readBootstrapSourceConfig(projectRoot, templatePath);

  // Bootstrap is the only time template-derived defaults are stamped into the runtime catalog.
  // After this write, runtime reads only the catalog.
  const { catalog: migratedCatalog } = migrateCatalogVariants(template);
  const seedCatIds = sourcePath === templatePath ? collectCatIds(migratedCatalog) : readSeedCatIds(templatePath);
  const runtimeCatalog = applyBootstrapDefaultAccountRefs(migratedCatalog, seedCatIds);

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
