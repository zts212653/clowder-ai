import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { CatCafeConfig, ClientId, RosterEntry } from '@cat-cafe/shared';
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

/**
 * clowder-ai#340: One-time catalog variant migration — rewrites file on disk then never runs again.
 *   1. old `provider` (clientId value) → `clientId` (P5 field rename)
 *   2. old `ocProviderName` → `provider` (P5 field rename)
 *   3. old `providerProfileId` → `accountRef` (P5 field rename)
 *   4. drop legacy variants whose catId is now a standalone top-level breed
 *      (e.g. `ragdoll.variants[opus-47]` after opus-47 was promoted to its own breed) —
 *      otherwise toAllCatConfigs throws Duplicate catId on startup.
 *
 * `externalStandaloneBreedIds` lets the caller surface breed.ids from the template
 * even when the runtime catalog hasn't picked them up yet — without it, a legacy
 * catalog merged with a new-shape template still trips the duplicate-catId crash.
 *
 * Bootstrap creates an empty catalog; template breeds are used as a menu when adding members.
 */
function migrateCatalogVariants(
  catalog: CatCafeConfig,
  externalStandaloneBreedIds?: ReadonlySet<string>,
): { catalog: CatCafeConfig; dirty: boolean } {
  let dirty = false;
  const next = structuredClone(catalog) as CatCafeConfig;

  // Step 4 prep: union the catalog's own breed ids with any external ones (template)
  // so legacy variants are dropped even when the catalog itself hasn't grown the new breed yet.
  const standaloneBreedIds = new Set<string>(externalStandaloneBreedIds ?? []);
  for (const breed of next.breeds as unknown as Record<string, unknown>[]) {
    if (typeof breed.id === 'string') standaloneBreedIds.add(breed.id);
  }

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

  // Step 4: drop legacy variants whose catId now belongs to a standalone top-level breed.
  // Triggered when a cat (e.g. opus-47) was previously a sub-variant of another breed
  // (ragdoll) and later got promoted to its own breed. Without this normalization,
  // toAllCatConfigs() throws Duplicate catId at startup once both forms coexist.
  for (const breed of next.breeds as unknown as Record<string, unknown>[]) {
    const breedId = typeof breed.id === 'string' ? breed.id : undefined;
    const breedDefaultCatId = typeof breed.catId === 'string' ? breed.catId : undefined;
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    if (variants.length === 0) continue;
    const filtered = variants.filter((variant) => {
      const variantCatId = (typeof variant.catId === 'string' ? variant.catId : undefined) ?? breedDefaultCatId;
      if (!variantCatId) return true;
      // Keep variants whose catId matches their own breed's id (legitimate single-variant breed).
      if (variantCatId === breedId) return true;
      // Drop only when catId points to a *different* standalone top-level breed.
      return !standaloneBreedIds.has(variantCatId);
    });
    if (filtered.length !== variants.length) {
      breed.variants = filtered;
      dirty = true;
    }
  }

  return { catalog: next, dirty };
}

/** One-time migration: strip legacy `source` field from variants. Idempotent.
 *  Template and runtime catalog are independent data sources — source field is obsolete. */
function stripLegacySourceField(catalogPath: string): void {
  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf-8');
  } catch {
    return;
  }
  const catalog = JSON.parse(raw) as CatCafeConfig;
  const next = structuredClone(catalog) as CatCafeConfig;
  let dirty = false;
  for (const breed of next.breeds as unknown as Record<string, unknown>[]) {
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      if ('source' in variant) {
        delete variant.source;
        dirty = true;
      }
    }
  }
  if (!dirty) return;
  writeFileAtomic(catalogPath, `${JSON.stringify(next, null, 2)}\n`);
}

const OWNER_ROSTER_KEY = 'owner';

function buildOwnerRosterEntry(): RosterEntry {
  return {
    family: 'owner',
    roles: ['owner'],
    lead: false,
    available: true,
    evaluation: '铲屎官 / 大当家',
  };
}

function createEmptyRuntimeCatalog(template: CatCafeConfig): CatCafeConfig {
  const ownerEntry = buildOwnerRosterEntry();
  if ('roster' in template) {
    return {
      ...template,
      breeds: [],
      roster: { [OWNER_ROSTER_KEY]: ownerEntry },
    };
  }
  return {
    ...template,
    breeds: [],
  };
}

/** Ensure the owner entry exists in an existing catalog. Returns true if backfilled. */
function ensureOwnerInRoster(catalogPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf-8');
  } catch {
    return false;
  }
  const catalog = JSON.parse(raw) as CatCafeConfig;
  if (!('roster' in catalog)) return false;
  const roster = catalog.roster as Record<string, unknown>;
  if (roster[OWNER_ROSTER_KEY]) return false;
  roster[OWNER_ROSTER_KEY] = buildOwnerRosterEntry();
  writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return true;
}

export function resolveCatCatalogPath(projectRoot: string): string {
  return safePath(projectRoot, CONFIG_SUBDIR, CAT_CATALOG_FILENAME);
}

/**
 * Best-effort read of breed.id values from a sibling cat-template.json.
 * Returns an empty set if the template is missing or unreadable — migration
 * still works against catalog-only ids in that case.
 */
function readTemplateBreedIds(projectRoot: string): Set<string> {
  const ids = new Set<string>();
  let templateRaw: string;
  try {
    templateRaw = readFileSync(safePath(projectRoot, 'cat-template.json'), 'utf-8');
  } catch {
    return ids;
  }
  try {
    const json = JSON.parse(templateRaw) as { breeds?: Array<{ id?: unknown }> };
    for (const breed of json.breeds ?? []) {
      if (typeof breed.id === 'string') ids.add(breed.id);
    }
  } catch {
    // Malformed template — treat as no external ids.
  }
  return ids;
}

export function readCatCatalogRaw(projectRoot: string): string | null {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  if (!existsSync(catalogPath)) return null;
  const raw = readFileSync(catalogPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as CatCafeConfig;
    // Hand the migration template breed.ids so it can detect legacy variants
    // that were promoted to standalone breeds in template but not yet here.
    const templateBreedIds = readTemplateBreedIds(projectRoot);
    const migrated = migrateCatalogVariants(parsed, templateBreedIds);
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

function readBootstrapSourceConfig(templatePath: string): { catalog: CatCafeConfig; sourcePath: string } {
  return {
    catalog: JSON.parse(readFileSync(templatePath, 'utf-8')) as CatCafeConfig,
    sourcePath: templatePath,
  };
}

export function bootstrapCatCatalog(projectRoot: string, templatePath: string): string {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  if (existsSync(catalogPath)) {
    readCatCatalogRaw(projectRoot);
    // Strip legacy source field from variants (obsolete after F171).
    stripLegacySourceField(catalogPath);
    // Ensure owner is always present in roster.
    ensureOwnerInRoster(catalogPath);
    return catalogPath;
  }

  const { catalog: template } = readBootstrapSourceConfig(templatePath);
  const { catalog: migratedCatalog } = migrateCatalogVariants(template);

  // Always start empty — first-run wizard guides users to add their first cat.
  // Template breeds are used as a menu when adding members, not seeded on startup.
  const runtimeCatalog = createEmptyRuntimeCatalog(migratedCatalog);

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
