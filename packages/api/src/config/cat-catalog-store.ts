import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { CatCafeConfig, ClientId, RosterEntry } from '@cat-cafe/shared';
import { resolveBuiltinClientForProvider } from './account-resolver.js';
import {
  GEMINI35_CAT_ID,
  GEMINI35_OLD_NAME,
  GEMINI35_OLD_ROLE_DESCRIPTION,
  GEMINI35_OLD_VARIANT_LABEL,
  LEGACY_GEMINI_CONSUMER_CAT_IDS,
  resolveAgyGeminiDefaultModel,
} from './agy-gemini-models.js';
import { inheritFullyBlockedMcpCapabilitiesForNewCatsSync } from './capabilities/capability-orchestrator.js';
import {
  pickSeedBreed,
  pruneRosterToRuntimeBreeds,
  type RuntimeBreedWithCatIds,
} from './cat-catalog-bootstrap-roster.js';
import {
  isTemplateBreedBackfillAllowed,
  isTemplateVariantBackfillAllowed,
  normalizeMentionAlias,
} from './template-variant-backfill.js';
import { isTemplateVariantTombstoned } from './template-variant-tombstones.js';

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
const CLIENT_ID_VALUES = new Set(['anthropic', 'openai', 'google', 'kimi', 'antigravity', 'opencode', 'a2a']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLegacyGeminiCliConfig(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const defaultArgs = value.defaultArgs;
  const hasNoDefaultArgs = defaultArgs === undefined ? true : Array.isArray(defaultArgs) && defaultArgs.length === 0;
  return value.command === 'gemini' && value.outputFormat === 'stream-json' && hasNoDefaultArgs;
}

function isLegacyGeminiAcpConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const startupArgs = value.startupArgs;
  return value.command === 'gemini' && Array.isArray(startupArgs) && startupArgs.includes('--acp');
}

function isAgyPlainTextCliConfig(value: unknown): boolean {
  return isRecord(value) && value.command === 'agy' && value.outputFormat === 'plainText';
}

function migrateLegacyGeminiConsumerCarrier(
  variant: Record<string, unknown>,
  breedDefaultCatId: string | undefined,
): boolean {
  const clientId = typeof variant.clientId === 'string' ? variant.clientId : variant.provider;
  if (clientId !== 'google') return false;

  const resolvedCatId = typeof variant.catId === 'string' ? variant.catId : breedDefaultCatId;
  if (!resolvedCatId) return false;
  if (!LEGACY_GEMINI_CONSUMER_CAT_IDS.has(resolvedCatId)) return false;

  let dirty = false;
  if (isLegacyGeminiCliConfig(variant.cli)) {
    variant.cli = {
      ...variant.cli,
      command: 'agy',
      outputFormat: 'plainText',
    };
    dirty = true;
  }
  if (isLegacyGeminiAcpConfig(variant.acp)) {
    variant.acp = null;
    dirty = true;
  }
  const agyDefaultModel = isAgyPlainTextCliConfig(variant.cli)
    ? resolveAgyGeminiDefaultModel(resolvedCatId, variant.defaultModel)
    : undefined;
  if (agyDefaultModel && variant.defaultModel !== agyDefaultModel) {
    variant.defaultModel = agyDefaultModel;
    dirty = true;
  }
  return dirty;
}

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

      if (migrateLegacyGeminiConsumerCarrier(variant, typeof breed.catId === 'string' ? breed.catId : undefined)) {
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
    evaluation: 'co-creator / 大当家',
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

function resolveVariantCatId(breed: Record<string, unknown>, variant: Record<string, unknown>): string | undefined {
  if (typeof variant.catId === 'string') return variant.catId;
  return typeof breed.catId === 'string' ? breed.catId : undefined;
}

type RuntimeIdentityOccupancy = {
  catIds: Set<string>;
  mentionAliases: Set<string>;
};

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function resolveVariantMentionPatterns(
  breed: Record<string, unknown>,
  variant: Record<string, unknown>,
  catId: string,
): string[] {
  const variantPatterns = readStringArray(variant.mentionPatterns);
  if (variantPatterns.length > 0) return variantPatterns;
  if (variant.id === breed.defaultVariantId) {
    const breedPatterns = readStringArray(breed.mentionPatterns);
    if (breedPatterns.length > 0) return breedPatterns;
  }
  return [`@${catId}`];
}

const GEMINI35_OLD_MENTION_ALIASES = new Set(
  ['@gemini35', '@gemini-35', '@gemini3.5', '@flash', '@暹罗flash', '@暹罗gemini35']
    .map(normalizeMentionAlias)
    .filter((alias): alias is string => !!alias),
);

function collectRuntimeIdentityOccupancy(breeds: Record<string, unknown>[]): RuntimeIdentityOccupancy {
  const catIds = new Set<string>();
  const mentionAliases = new Set<string>();
  for (const breed of breeds) {
    const breedCatId = typeof breed.catId === 'string' ? breed.catId : undefined;
    if (breedCatId) catIds.add(breedCatId);
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      const variantCatId = resolveVariantCatId(breed, variant);
      if (!variantCatId) continue;
      catIds.add(variantCatId);
      for (const pattern of resolveVariantMentionPatterns(breed, variant, variantCatId)) {
        const normalized = normalizeMentionAlias(pattern);
        if (normalized) mentionAliases.add(normalized);
      }
    }
  }
  return { catIds, mentionAliases };
}

function hasTombstonedTemplateBreedVariant(
  catalog: Record<string, unknown>,
  templateBreed: Record<string, unknown>,
): boolean {
  const breedId = typeof templateBreed.id === 'string' ? templateBreed.id : undefined;
  const breedCatId = typeof templateBreed.catId === 'string' ? templateBreed.catId : undefined;
  const variants = Array.isArray(templateBreed.variants) ? (templateBreed.variants as unknown[]) : [];
  if (!breedId) return false;

  for (const variant of variants) {
    if (!isRecord(variant)) continue;
    if (typeof variant.id !== 'string') continue;
    const catId = resolveVariantCatId({ catId: breedCatId }, variant);
    if (!catId) continue;
    if (isTemplateVariantTombstoned(catalog, { breedId, variantId: variant.id, catId })) return true;
  }
  return false;
}

function persistMissingTemplateBreeds(projectRoot: string, catalogPath: string, templatePath: string): boolean {
  let catalogRaw: string;
  let templateRaw: string;
  try {
    catalogRaw = readFileSync(catalogPath, 'utf-8');
    templateRaw = readFileSync(templatePath, 'utf-8');
  } catch {
    return false;
  }

  const catalog = JSON.parse(catalogRaw) as CatCafeConfig;
  const template = JSON.parse(templateRaw) as CatCafeConfig;
  const next = structuredClone(catalog) as CatCafeConfig;
  const nextBreeds = next.breeds as unknown as Record<string, unknown>[];
  const existingBreedIds = new Set(
    nextBreeds.map((breed) => breed.id).filter((id): id is string => typeof id === 'string'),
  );
  const templateRoster =
    template.version === 2 ? (template.roster as unknown as Record<string, unknown>) : ({} as Record<string, unknown>);
  const nextRoster =
    next.version === 2 ? (next.roster as unknown as Record<string, unknown>) : ({} as Record<string, unknown>);
  const occupancy = collectRuntimeIdentityOccupancy(nextBreeds);
  const existingCatIds = new Set(occupancy.catIds);
  const backfilledCatIds: string[] = [];

  let dirty = false;
  for (const templateBreed of template.breeds as unknown as Record<string, unknown>[]) {
    if (typeof templateBreed.id !== 'string') continue;
    if (typeof templateBreed.catId !== 'string') continue;
    if (existingBreedIds.has(templateBreed.id)) continue;
    if (hasTombstonedTemplateBreedVariant(catalog as unknown as Record<string, unknown>, templateBreed)) continue;

    const templateBreedOccupancy = collectRuntimeIdentityOccupancy([templateBreed]);
    const templateBreedCatIds = [...templateBreedOccupancy.catIds];
    const templateBreedAliases = [...templateBreedOccupancy.mentionAliases];
    if (
      !isTemplateBreedBackfillAllowed(
        {
          breedId: templateBreed.id,
          catId: templateBreed.catId,
          catIds: templateBreedCatIds,
          mentionPatterns: templateBreedAliases,
        },
        occupancy,
      )
    ) {
      continue;
    }

    nextBreeds.push(structuredClone(templateBreed));
    existingBreedIds.add(templateBreed.id);
    for (const catId of templateBreedCatIds) {
      occupancy.catIds.add(catId);
      backfilledCatIds.push(catId);
      if (next.version === 2 && !nextRoster[catId] && templateRoster[catId]) {
        nextRoster[catId] = structuredClone(templateRoster[catId]);
      }
    }
    for (const alias of templateBreedAliases) occupancy.mentionAliases.add(alias);
    dirty = true;
  }

  if (!dirty) return false;
  writeFileAtomic(catalogPath, `${JSON.stringify(next, null, 2)}\n`);
  inheritFullyBlockedMcpCapabilitiesForNewCatsSync(projectRoot, backfilledCatIds, existingCatIds);
  return true;
}

function persistMissingTemplateVariants(projectRoot: string, catalogPath: string, templatePath: string): boolean {
  let catalogRaw: string;
  let templateRaw: string;
  try {
    catalogRaw = readFileSync(catalogPath, 'utf-8');
    templateRaw = readFileSync(templatePath, 'utf-8');
  } catch {
    return false;
  }

  const catalog = JSON.parse(catalogRaw) as CatCafeConfig;
  const template = JSON.parse(templateRaw) as CatCafeConfig;
  const next = structuredClone(catalog) as CatCafeConfig;
  const templateBreeds = new Map<string, Record<string, unknown>>();
  for (const breed of template.breeds as unknown as Record<string, unknown>[]) {
    if (typeof breed.id === 'string') templateBreeds.set(breed.id, breed);
  }

  let dirty = false;
  const templateRoster =
    template.version === 2 ? (template.roster as unknown as Record<string, unknown>) : ({} as Record<string, unknown>);
  const nextRoster =
    next.version === 2 ? (next.roster as unknown as Record<string, unknown>) : ({} as Record<string, unknown>);
  const occupancy = collectRuntimeIdentityOccupancy(next.breeds as unknown as Record<string, unknown>[]);
  const existingCatIds = new Set(occupancy.catIds);
  const backfilledCatIds: string[] = [];

  for (const breed of next.breeds as unknown as Record<string, unknown>[]) {
    if (typeof breed.id !== 'string') continue;
    const templateBreed = templateBreeds.get(breed.id);
    if (!templateBreed) continue;

    const variants = Array.isArray(breed.variants) ? (breed.variants as unknown[]) : [];
    const templateVariants = Array.isArray(templateBreed.variants) ? (templateBreed.variants as unknown[]) : [];
    const existingVariantIds = new Set(
      variants
        .filter((variant): variant is Record<string, unknown> => isRecord(variant))
        .map((variant) => variant.id)
        .filter((id): id is string => typeof id === 'string'),
    );

    for (const templateVariantUnknown of templateVariants) {
      if (!isRecord(templateVariantUnknown)) continue;
      if (typeof templateVariantUnknown.id !== 'string') continue;
      if (existingVariantIds.has(templateVariantUnknown.id)) continue;

      const catId = resolveVariantCatId(templateBreed, templateVariantUnknown);
      const mentionPatterns = catId ? resolveVariantMentionPatterns(templateBreed, templateVariantUnknown, catId) : [];
      if (
        !catId ||
        !isTemplateVariantBackfillAllowed(
          {
            breedId: breed.id,
            variantId: templateVariantUnknown.id,
            catId,
            mentionPatterns,
          },
          occupancy,
        )
      ) {
        continue;
      }
      if (
        isTemplateVariantTombstoned(catalog as unknown as Record<string, unknown>, {
          breedId: breed.id,
          variantId: templateVariantUnknown.id,
          catId,
        })
      ) {
        continue;
      }

      variants.push(structuredClone(templateVariantUnknown));
      existingVariantIds.add(templateVariantUnknown.id);
      occupancy.catIds.add(catId);
      backfilledCatIds.push(catId);
      for (const pattern of mentionPatterns) {
        const normalized = normalizeMentionAlias(pattern);
        if (normalized) occupancy.mentionAliases.add(normalized);
      }
      dirty = true;

      if (next.version === 2 && catId && !nextRoster[catId] && templateRoster[catId]) {
        nextRoster[catId] = structuredClone(templateRoster[catId]);
      }
    }

    if (!Array.isArray(breed.variants) && variants.length > 0) {
      breed.variants = variants;
      dirty = true;
    }
  }

  if (!dirty) return false;
  writeFileAtomic(catalogPath, `${JSON.stringify(next, null, 2)}\n`);
  inheritFullyBlockedMcpCapabilitiesForNewCatsSync(projectRoot, backfilledCatIds, existingCatIds);
  return true;
}

function isGemini35Breed(breed: Record<string, unknown>): boolean {
  if (breed.catId === GEMINI35_CAT_ID) return true;
  const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
  return variants.some((variant) => resolveVariantCatId(breed, variant) === GEMINI35_CAT_ID);
}

function collectMentionAliasesExcludingBreed(
  breeds: Record<string, unknown>[],
  excludedBreed: Record<string, unknown>,
): Set<string> {
  const aliases = new Set<string>();
  for (const breed of breeds) {
    if (breed === excludedBreed) continue;
    for (const pattern of readStringArray(breed.mentionPatterns)) {
      const normalized = normalizeMentionAlias(pattern);
      if (normalized) aliases.add(normalized);
    }
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      const catId = resolveVariantCatId(breed, variant);
      if (!catId) continue;
      for (const pattern of resolveVariantMentionPatterns(breed, variant, catId)) {
        const normalized = normalizeMentionAlias(pattern);
        if (normalized) aliases.add(normalized);
      }
    }
  }
  return aliases;
}

function collectMentionAliasesForBreed(breed: Record<string, unknown>): Set<string> {
  const aliases = new Set<string>();
  for (const pattern of readStringArray(breed.mentionPatterns)) {
    const normalized = normalizeMentionAlias(pattern);
    if (normalized) aliases.add(normalized);
  }
  const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
  for (const variant of variants) {
    const catId = resolveVariantCatId(breed, variant);
    if (!catId) continue;
    for (const pattern of resolveVariantMentionPatterns(breed, variant, catId)) {
      const normalized = normalizeMentionAlias(pattern);
      if (normalized) aliases.add(normalized);
    }
  }
  return aliases;
}

function syncGemini35TemplateUpgrade(catalogPath: string, templatePath: string): boolean {
  let catalogRaw: string;
  let templateRaw: string;
  try {
    catalogRaw = readFileSync(catalogPath, 'utf-8');
    templateRaw = readFileSync(templatePath, 'utf-8');
  } catch {
    return false;
  }

  const catalog = JSON.parse(catalogRaw) as CatCafeConfig;
  const template = JSON.parse(templateRaw) as CatCafeConfig;
  const templateBreed = (template.breeds as unknown as Record<string, unknown>[]).find(isGemini35Breed);
  if (!templateBreed) return false;
  const templateVariants = Array.isArray(templateBreed.variants)
    ? (templateBreed.variants as Record<string, unknown>[])
    : [];

  const next = structuredClone(catalog) as CatCafeConfig;
  const nextBreeds = next.breeds as unknown as Record<string, unknown>[];
  let dirty = false;

  for (const breed of nextBreeds) {
    if (!isGemini35Breed(breed)) continue;

    if (breed.name === GEMINI35_OLD_NAME && typeof templateBreed.name === 'string') {
      breed.name = templateBreed.name;
      dirty = true;
    }
    if (breed.roleDescription === GEMINI35_OLD_ROLE_DESCRIPTION && typeof templateBreed.roleDescription === 'string') {
      breed.roleDescription = templateBreed.roleDescription;
      dirty = true;
    }

    const breedPatterns = readStringArray(breed.mentionPatterns);
    const existingAliases = collectMentionAliasesForBreed(breed);
    const occupiedAliases = collectMentionAliasesExcludingBreed(nextBreeds, breed);
    let patternsDirty = false;
    for (const pattern of readStringArray(templateBreed.mentionPatterns)) {
      const normalized = normalizeMentionAlias(pattern);
      if (
        !normalized ||
        GEMINI35_OLD_MENTION_ALIASES.has(normalized) ||
        existingAliases.has(normalized) ||
        occupiedAliases.has(normalized)
      ) {
        continue;
      }
      breedPatterns.push(pattern);
      existingAliases.add(normalized);
      patternsDirty = true;
      dirty = true;
    }
    if (patternsDirty) breed.mentionPatterns = breedPatterns;

    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      if (resolveVariantCatId(breed, variant) !== GEMINI35_CAT_ID) continue;
      const templateVariant =
        templateVariants.find((candidate) => candidate.id === variant.id) ??
        templateVariants.find((candidate) => resolveVariantCatId(templateBreed, candidate) === GEMINI35_CAT_ID);
      if (
        variant.variantLabel === GEMINI35_OLD_VARIANT_LABEL &&
        templateVariant &&
        typeof templateVariant.variantLabel === 'string'
      ) {
        variant.variantLabel = templateVariant.variantLabel;
        dirty = true;
      }
    }
  }

  if (!dirty) return false;
  writeFileAtomic(catalogPath, `${JSON.stringify(next, null, 2)}\n`);
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

// NOTE: Repairing existing empty catalogs (e.g. Windows reinstall where user-data
// dir survives) is intentionally NOT done here — we cannot distinguish "broken
// install with empty breeds" from "user intentionally deleted all members".
// Existing-install repair needs a separate mechanism (e.g. _bootstrapVersion marker).
// See #948 for follow-up.

export function bootstrapCatCatalog(projectRoot: string, templatePath: string): string {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  if (existsSync(catalogPath)) {
    readCatCatalogRaw(projectRoot);
    // Strip legacy source field from variants (obsolete after F171).
    stripLegacySourceField(catalogPath);
    // Ensure owner is always present in roster.
    ensureOwnerInRoster(catalogPath);
    // Persist allowlisted template-added breeds so promoted house cats become
    // runtime members without reopening the template-only breed leak fixed by #772.
    persistMissingTemplateBreeds(projectRoot, catalogPath, templatePath);
    // Persist template-added variants into already-enabled runtime breeds so
    // read and write paths agree after upgrades.
    persistMissingTemplateVariants(projectRoot, catalogPath, templatePath);
    // Keep built-in Gemini Flash identity fields aligned for existing catalogs
    // whose runtime copy would otherwise keep pre-upgrade 3.5 names and aliases.
    syncGemini35TemplateUpgrade(catalogPath, templatePath);
    return catalogPath;
  }

  const { catalog: template } = readBootstrapSourceConfig(templatePath);
  const { catalog: migratedCatalog } = migrateCatalogVariants(template);

  // #948: Seed the first breed from the template so the app starts with at least
  // one usable member. Without this, the registry is empty and the frontend
  // crashes before the first-run wizard is reachable.
  // In dev environments (template has no breeds), start empty — developers use
  // the wizard or manual config to add members.
  const seedBreed = pickSeedBreed(migratedCatalog);

  let runtimeCatalog: CatCafeConfig;
  if (seedBreed) {
    const seedBreeds = [seedBreed as CatCafeConfig['breeds'][number]];
    runtimeCatalog = {
      ...migratedCatalog,
      breeds: seedBreeds,
    };
    if ('roster' in runtimeCatalog) {
      (runtimeCatalog as { roster: Record<string, RosterEntry> }).roster = pruneRosterToRuntimeBreeds(
        runtimeCatalog.roster as Record<string, RosterEntry>,
        seedBreeds as RuntimeBreedWithCatIds[],
        OWNER_ROSTER_KEY,
        buildOwnerRosterEntry(),
      );
    }
  } else {
    // Template has no breeds — start empty (first-run wizard guides member addition).
    runtimeCatalog = createEmptyRuntimeCatalog(migratedCatalog);
  }

  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileAtomic(catalogPath, `${JSON.stringify(runtimeCatalog, null, 2)}\n`);
  persistMissingTemplateBreeds(projectRoot, catalogPath, templatePath);
  return catalogPath;
}

export function writeCatCatalog(projectRoot: string, catalog: CatCafeConfig): string {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return catalogPath;
}
