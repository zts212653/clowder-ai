/**
 * Cat Config Loader
 * 从 cat-template.json / .cat-cafe/cat-catalog.json 加载 Breed+Variant 配置。
 * Node-only — 前端继续用 shared 包的 CAT_CONFIGS 常量。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CatBreed,
  CatCafeConfig,
  CatConfig,
  CatFeatures,
  CatId,
  CatVariant,
  CoCreatorConfig,
  ContextBudget,
  MissionHubSelfClaimScope,
  ReviewPolicy,
  Roster,
} from '@cat-cafe/shared';
import { type ClientId, createCatId, normalizeCliEffortForProvider } from '@cat-cafe/shared';
import { z } from 'zod';
import { createModuleLogger } from '../infrastructure/logger.js';
import { bootstrapCatCatalog, readCatCatalogRaw, resolveCatCatalogPath } from './cat-catalog-store.js';

const log = createModuleLogger('cat-config');

/**
 * Default cat-template.json location (repo root).
 *
 * IMPORTANT: API dev scripts run with cwd=`packages/api`, so `process.cwd()` is
 * not the repo root. Resolve relative to this file instead to keep behavior
 * stable across different launch directories.
 */
const DEFAULT_CAT_TEMPLATE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..', 'cat-template.json');

const cliConfigSchema = z.object({
  command: z.string().min(1),
  outputFormat: z.string().min(1),
  defaultArgs: z.array(z.string()).optional(),
  effort: z.enum(['low', 'medium', 'high', 'max', 'xhigh']).optional(),
  contextWindow: z.number().positive().int().optional(),
  autoCompactTokenLimit: z.number().positive().int().optional(),
});

const contextBudgetSchema = z.object({
  maxPromptTokens: z.number().positive(),
  maxContextTokens: z.number().positive(),
  maxMessages: z.number().positive().int(),
  maxContentLengthPerMsg: z.number().positive(),
});

/** F32-b: mentionPatterns must start with @ */
const mentionPatternSchema = z.string().min(2).regex(/^@/, 'mentionPattern must start with @');

const colorSchema = z.object({ primary: z.string(), secondary: z.string() });

const catVariantSchema = z.object({
  id: z.string().min(1),
  catId: z.string().min(1).optional(), // F32-b: variant-level catId
  displayName: z.string().min(1).optional(), // F32-b: variant-level displayName
  variantLabel: z.string().min(1).optional(), // F32-b P4: disambiguation label
  mentionPatterns: z.array(mentionPatternSchema).optional(), // F32-b: variant-level mentions
  source: z.enum(['seed', 'runtime']).optional(), // #441: bootstrap-stamped origin
  accountRef: z.string().min(1).optional(), // F127: concrete account binding
  clientId: z.enum(['anthropic', 'openai', 'google', 'kimi', 'dare', 'antigravity', 'opencode', 'a2a', 'catagent']),

  defaultModel: z.string().min(1),
  mcpSupport: z.boolean(),
  cli: cliConfigSchema.optional(),
  commandArgs: z.array(z.string().min(1)).optional(), // F127: explicit bridge args (e.g. Antigravity)
  cliConfigArgs: z.array(z.string().min(1)).optional(), // F127: extra CLI args per member
  /** clowder-ai#340 P5: Model provider name (renamed from ocProviderName). */
  provider: z
    .string()
    .trim()
    .min(1, 'provider must not be blank')
    .refine((v) => !v.includes('/'), 'provider must not contain "/"')
    .optional(),
  roleDescription: z.string().min(1).optional(), // F127 review fix: allow variant-scoped roleDescription override
  sessionChain: z.boolean().optional(), // F127 review fix: allow variant-scoped sessionChain override
  personality: z.string().optional(),
  strengths: z.array(z.string()).optional(),
  avatar: z.string().min(1).optional(), // F32-b P4c: override breed avatar
  color: colorSchema.optional(), // F32-b P4c: override breed color
  contextBudget: contextBudgetSchema.optional(),
  voiceConfig: z // F103: per-cat TTS voice configuration
    .object({
      voice: z.string().min(1),
      langCode: z.string().min(1),
      speed: z.number().positive().optional(),
      refAudio: z.string().min(1).optional(),
      refText: z.string().min(1).optional(),
      instruct: z.string().min(1).optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .optional(),
  teamStrengths: z.string().optional(), // F-Ground-3: human-readable strengths
  caution: z.string().nullable().optional(), // F-Ground-3: null = explicit no-caution (R1 fix)
});

/** F33 Phase 2: session strategy config (matches SessionStrategyConfig from shared).
 *  Exported for reuse by Phase 3 API route validation. */
export const sessionStrategySchema = z
  .object({
    strategy: z.enum(['handoff', 'compress', 'hybrid']),
    thresholds: z
      .object({
        warn: z.number().min(0).max(1),
        action: z.number().min(0).max(1),
      })
      .refine((t) => t.warn < t.action, { message: 'thresholds.warn must be less than thresholds.action' })
      .optional(),
    handoff: z
      .object({
        preSealMemoryDump: z.boolean(),
        bootstrapDepth: z.enum(['extractive', 'generative']),
      })
      .optional(),
    compress: z
      .object({
        maxCompressions: z.number().int().positive().optional(),
        trackPostCompression: z.boolean(),
      })
      .optional(),
    hybrid: z
      .object({
        maxCompressions: z.number().int().positive(),
      })
      .optional(),
    turnBudget: z.number().int().positive().optional(),
    safetyMargin: z.number().int().positive().optional(),
  })
  .optional();

const catFeaturesSchema = z
  .object({
    sessionChain: z.boolean().optional(),
    sessionStrategy: sessionStrategySchema,
    missionHub: z
      .object({
        selfClaimScope: z.enum(['disabled', 'once', 'thread', 'global']).optional(),
      })
      .optional(),
  })
  .optional();

const catBreedSchema = z.object({
  id: z.string().min(1),
  catId: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  nickname: z.string().nullable().optional(),
  avatar: z.string().min(1),
  color: colorSchema,
  mentionPatterns: z.array(mentionPatternSchema).min(1),
  roleDescription: z.string().min(1),
  defaultVariantId: z.string().min(1),
  variants: z.array(catVariantSchema).min(1),
  features: catFeaturesSchema,
  teamStrengths: z.string().optional(), // F-Ground-3: breed-level default
  caution: z.string().nullable().optional(), // F-Ground-3: null = explicit no-caution (R1 fix)
});

// ── F032: Roster schema for collaboration rules ──────────────────────

/** Roster entry for a single cat */
const rosterEntrySchema = z.object({
  family: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
  lead: z.boolean(),
  available: z.boolean(),
  evaluation: z.string().min(1),
});

/** Review policy configuration */
const reviewPolicySchema = z.object({
  requireDifferentFamily: z.boolean(),
  preferActiveInThread: z.boolean(),
  preferLead: z.boolean(),
  excludeUnavailable: z.boolean(),
});

// Note: Roster, RosterEntry, ReviewPolicy types imported from @cat-cafe/shared above

/** F067: Owner config schema */
const coCreatorConfigSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  mentionPatterns: z.array(mentionPatternSchema).min(1),
  avatar: z.string().min(1).optional(),
  color: colorSchema.optional(),
});

/** Version 1: breeds only (legacy) */
const catCafeConfigSchemaV1 = z.object({
  version: z.literal(1),
  breeds: z.array(catBreedSchema).min(1),
});

/** Version 2: breeds + roster + reviewPolicy (F032) + coCreator (F067) */
const catCafeConfigSchemaV2 = z
  .object({
    version: z.literal(2),
    breeds: z.array(catBreedSchema).min(1),
    roster: z.record(z.string(), rosterEntrySchema),
    reviewPolicy: reviewPolicySchema,
    coCreator: coCreatorConfigSchema.optional(),
    /** @deprecated Accepted for backward compat; migrated to coCreator at parse time. */
    owner: coCreatorConfigSchema.optional(),
  })
  .transform((data) => {
    // Migrate legacy "owner" key → "coCreator" (coCreator takes precedence)
    const { owner: legacyOwner, ...rest } = data;
    if (!rest.coCreator && legacyOwner) {
      return { ...rest, coCreator: legacyOwner };
    }
    return rest;
  });

/** Union of all versions — loader handles migration */
const catCafeConfigSchema = z.union([catCafeConfigSchemaV1, catCafeConfigSchemaV2]);

/** clowder-ai#340: Read cat-template.json directly — cat-config.json is no longer a runtime source. */
function readTemplate(templatePath: string): string {
  try {
    return readFileSync(templatePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(`Failed to read cat-template.json at ${templatePath}: ${code ?? 'unknown error'}`);
  }
}

/**
 * Keys that represent atomic config units — overlay replaces base entirely,
 * even though they are plain objects. Prevents stale sub-fields from leaking
 * across provider switches (e.g. template cli.defaultArgs surviving into a
 * catalog variant that switched to a different client).
 */
const ATOMIC_OBJECT_KEYS = new Set(['cli', 'color', 'contextBudget', 'voiceConfig']);

/**
 * Deep merge two plain objects. `overlay` fields override `base` fields.
 * - Atomic keys (cli, color, etc.): overlay replaces base entirely.
 * - Other objects: recursively merged (base fields preserved if absent from overlay).
 * - Arrays of objects with `id`: key-based merge (matched by id, then deep-merged).
 *   Overlay-only items appended; base-only items preserved.
 * - Other arrays / primitives: overlay replaces base.
 */
function deepMergeConfig(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overlay)) {
    const bVal = base[key];
    const oVal = overlay[key];
    if (ATOMIC_OBJECT_KEYS.has(key)) {
      merged[key] = oVal;
    } else if (Array.isArray(oVal) && Array.isArray(bVal) && oVal.length > 0 && isIdArray(oVal) && isIdArray(bVal)) {
      merged[key] = mergeById(bVal as HasId[], oVal as HasId[]);
    } else if (isPlainObject(oVal) && isPlainObject(bVal)) {
      merged[key] = deepMergeConfig(bVal as Record<string, unknown>, oVal as Record<string, unknown>);
    } else {
      merged[key] = oVal;
    }
  }
  return merged;
}

type HasId = Record<string, unknown> & { id: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isIdArray(arr: unknown[]): arr is HasId[] {
  return (
    arr.length > 0 &&
    arr.every((item) => isPlainObject(item) && typeof (item as Record<string, unknown>).id === 'string')
  );
}

function mergeById(base: HasId[], overlay: HasId[]): HasId[] {
  const baseMap = new Map(base.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const result: HasId[] = [];
  for (const oItem of overlay) {
    seen.add(oItem.id);
    const bItem = baseMap.get(oItem.id);
    result.push(bItem ? (deepMergeConfig(bItem, oItem) as HasId) : oItem);
  }
  // Preserve base-only items (new items added to cat-config.json but not yet in catalog)
  for (const bItem of base) {
    if (!seen.has(bItem.id)) result.push(bItem);
  }
  return result;
}

/**
 * Load and validate the resolved cat config source.
 * Explicit filePath reads that file directly.
 * Default resolution: cat-template.json is the base, .cat-cafe/cat-catalog.json is a delta overlay.
 * Catalog fields override config fields (deep merge); config fields absent from catalog are preserved.
 */
export function loadCatConfig(filePath?: string): CatCafeConfig {
  let raw: string;
  let resolvedPath = filePath;
  if (filePath) {
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(`Failed to read cat config at ${filePath}: ${code ?? 'unknown error'}`);
    }
  } else {
    const templatePath = process.env.CAT_TEMPLATE_PATH ?? DEFAULT_CAT_TEMPLATE_PATH;
    const projectRoot = dirname(templatePath);
    const catalogRaw = readCatCatalogRaw(projectRoot);
    if (catalogRaw !== null) {
      // Catalog exists — use template as base, catalog as overlay
      const baseRaw = readTemplate(templatePath);
      const baseJson = JSON.parse(baseRaw) as Record<string, unknown>;
      const catalogJson = JSON.parse(catalogRaw) as Record<string, unknown>;
      raw = JSON.stringify(deepMergeConfig(baseJson, catalogJson));
      resolvedPath = resolveCatCatalogPath(projectRoot);
    } else {
      raw = readTemplate(templatePath);
      resolvedPath = templatePath;
    }
  }

  const json: unknown = JSON.parse(raw);
  const result = catCafeConfigSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid cat config:\n${issues.join('\n')}`);
  }

  // Validate defaultVariantId references
  for (const breed of result.data.breeds) {
    const found = breed.variants.find((v) => v.id === breed.defaultVariantId);
    if (!found) {
      throw new Error(`Breed "${breed.id}": defaultVariantId "${breed.defaultVariantId}" not found in variants`);
    }
  }

  // Validate that configured mentionPatterns are non-empty.
  // The canonical @catId handle is no longer required — users may replace it
  // with custom aliases via the Hub editor, as long as at least one alias exists.
  for (const breed of result.data.breeds) {
    if (breed.mentionPatterns.length === 0) {
      throw new Error(`Breed "${breed.id}": mentionPatterns must have at least one entry`);
    }
  }

  // Zod output has mutable arrays + plain string catId;
  // CatCafeConfig has readonly arrays + branded CatId.
  // The shapes match at runtime after validation.
  return result.data as unknown as CatCafeConfig;
}

export function bootstrapDefaultCatCatalog(templatePath?: string): CatCafeConfig {
  const resolvedTemplatePath = templatePath ?? process.env.CAT_TEMPLATE_PATH ?? DEFAULT_CAT_TEMPLATE_PATH;
  const projectRoot = dirname(resolvedTemplatePath);
  const catalogPath = bootstrapCatCatalog(projectRoot, resolvedTemplatePath);
  return loadCatConfig(catalogPath);
}

/** Get the default variant for a breed */
export function getDefaultVariant(breed: CatBreed): CatVariant {
  const found = breed.variants.find((variant) => variant.id === breed.defaultVariantId);
  if (!found) throw new Error(`Default variant "${breed.defaultVariantId}" not found for breed "${breed.id}"`);
  return found;
}

/**
 * F32-b: Register ALL variants as independent cats.
 * Each variant becomes a CatConfig entry keyed by its catId.
 * Default variant inherits breed-level mentionPatterns; others default to @catId when unspecified.
 * @throws Error on duplicate catId (fail-fast at startup)
 */
export function toAllCatConfigs(config: CatCafeConfig): Record<string, CatConfig> {
  const result: Record<
    string,
    CatConfig & {
      contextBudget?: ContextBudget;
    }
  > = {};
  for (const breed of config.breeds) {
    // F32-b P4c: resolve default variant personality for non-default fallback
    const defaultVariant = breed.variants.find((v) => v.id === breed.defaultVariantId);

    for (const variant of breed.variants) {
      const isDefault = variant.id === breed.defaultVariantId;
      const catId = variant.catId ?? breed.catId;
      const fallbackMentionPatterns = isDefault ? breed.mentionPatterns : [`@${catId}`];
      const mentionPatterns =
        variant.mentionPatterns && variant.mentionPatterns.length > 0
          ? variant.mentionPatterns
          : fallbackMentionPatterns;

      // F32-b R3: catId uniqueness — duplicate is a hard error (startup failure)
      if (result[catId]) {
        throw new Error(
          `Duplicate catId "${catId}": variant "${variant.id}" in breed "${breed.id}" ` +
            `conflicts with already registered cat. Each variant must have a unique catId.`,
        );
      }

      const teamStrengths = variant.teamStrengths ?? breed.teamStrengths;
      // R1 fix: null = "explicitly no caution" (don't inherit breed).
      // undefined (omitted) = inherit from breed. ?? treats null as nullish, so use !== undefined.
      const caution = variant.caution !== undefined ? variant.caution : breed.caution;
      const projectedCommandArgs =
        variant.commandArgs ??
        (variant.clientId === 'antigravity' && variant.cli?.defaultArgs && variant.cli.defaultArgs.length > 0
          ? variant.cli.defaultArgs
          : undefined);

      result[catId] = {
        id: createCatId(catId),
        name: variant.displayName ?? breed.name,
        displayName: variant.displayName ?? breed.displayName,
        ...(breed.nickname != null ? { nickname: breed.nickname } : {}),
        avatar: variant.avatar ?? breed.avatar, // F32-b P4c: variant can override
        color: variant.color ?? breed.color, // F32-b P4c: variant can override
        mentionPatterns,
        ...(variant.source != null ? { source: variant.source } : {}),
        ...(variant.accountRef != null ? { accountRef: variant.accountRef } : {}),
        clientId: variant.clientId,
        defaultModel: variant.defaultModel,
        mcpSupport: variant.mcpSupport,
        ...(projectedCommandArgs != null ? { commandArgs: projectedCommandArgs } : {}),
        ...(variant.cliConfigArgs != null && variant.cliConfigArgs.length > 0
          ? { cliConfigArgs: [...variant.cliConfigArgs] }
          : {}),
        ...(variant.cli != null ? { cli: variant.cli } : {}),
        ...(variant.provider != null ? { provider: variant.provider } : {}),
        ...(variant.contextBudget != null ? { contextBudget: variant.contextBudget } : {}),
        roleDescription: variant.roleDescription ?? breed.roleDescription,
        personality: variant.personality ?? defaultVariant?.personality ?? '',
        breedId: breed.id,
        breedDisplayName: breed.displayName,
        ...(variant.variantLabel != null ? { variantLabel: variant.variantLabel } : {}),
        isDefaultVariant: isDefault,
        ...(teamStrengths != null ? { teamStrengths } : {}),
        // R1 fix: preserve null (explicit no-caution) in CatConfig; only omit if undefined
        ...(caution !== undefined ? { caution } : {}),
        ...(variant.strengths != null ? { strengths: variant.strengths } : {}),
        ...(variant.sessionChain !== undefined
          ? { sessionChain: variant.sessionChain }
          : breed.features?.sessionChain !== undefined
            ? { sessionChain: breed.features.sessionChain }
            : {}),
      };
    }
  }
  return result;
}

/** Backward-compat alias — now registers all variants, not just defaults */
export function toFlatConfigs(config: CatCafeConfig): Record<string, CatConfig> {
  return toAllCatConfigs(config);
}

/**
 * F032 P2 cleanup: Get all cat IDs from config (replaces hardcoded fallbacks).
 * Used by cat-voices.ts, cat-budgets.ts, TaskExtractor.ts.
 */
export function getAllCatIdsFromConfig(): readonly string[] {
  try {
    const config = getCachedConfig();
    if (!config) return [];
    return Object.keys(toAllCatConfigs(config));
  } catch {
    return []; // If config fails to load, return empty (caller decides fallback)
  }
}

/**
 * Find a breed by checking mention patterns against text.
 * F32-b P4c: Uses longest-match-first to avoid prefix collisions
 * (e.g. `@布偶sonnet` must match Sonnet variant, not breed-level `@布偶`).
 */
export function findBreedByMention(config: CatCafeConfig, text: string): { breed: CatBreed; catId: CatId } | undefined {
  const lower = text.toLowerCase();

  // Collect all patterns with their resolution targets
  const entries: { pattern: string; breed: CatBreed; catId: string }[] = [];
  for (const breed of config.breeds) {
    for (const pattern of breed.mentionPatterns) {
      entries.push({ pattern: pattern.toLowerCase(), breed, catId: breed.catId });
    }
    for (const variant of breed.variants) {
      if (variant.mentionPatterns) {
        const catId = variant.catId ?? breed.catId;
        for (const pattern of variant.mentionPatterns) {
          entries.push({ pattern: pattern.toLowerCase(), breed, catId });
        }
      }
    }
  }

  // Sort longest-first to prevent prefix collisions
  entries.sort((a, b) => b.pattern.length - a.pattern.length);

  for (const entry of entries) {
    if (lower.includes(entry.pattern)) {
      return { breed: entry.breed, catId: createCatId(entry.catId) };
    }
  }
  return undefined;
}

// ── F24 Feature Toggle ──────────────────────────────────────────────

let _cachedConfig: CatCafeConfig | null = null;
let _configLoadFailed = false;

function getCachedConfig(): CatCafeConfig | null {
  if (_configLoadFailed) return null;
  if (!_cachedConfig) {
    try {
      _cachedConfig = loadCatConfig();
    } catch (err) {
      _configLoadFailed = true;
      log.warn({ err }, 'Failed to load runtime catalog/template config, F24 toggle will default to enabled');
      return null;
    }
  }
  return _cachedConfig;
}

// ── F32-b: catId → breed index (for variant-aware feature lookups) ────

/**
 * Build an index mapping every catId (including variant-level) to its parent breed.
 * Used by isSessionChainEnabled() to correctly resolve features for variants.
 */
export function buildCatIdToBreedIndex(config: CatCafeConfig): Map<string, CatBreed> {
  const index = new Map<string, CatBreed>();
  for (const breed of config.breeds) {
    for (const variant of breed.variants) {
      const catId = variant.catId ?? breed.catId;
      index.set(catId, breed);
    }
  }
  return index;
}

// Cache bound to config reference — rebuilt if different config is passed (e.g. tests)
let _catIdToBreed: Map<string, CatBreed> | null = null;
let _catIdToBreedSource: CatCafeConfig | null = null;

/**
 * Check if F24 session chain is enabled for a cat.
 * Returns true by default — only false when explicitly disabled in cat-config.json.
 * Gracefully returns true if config file is unreadable (availability over strictness).
 *
 * F32-b: Now resolves variant catIds to their parent breed via index.
 * Design constraint: Cat Cafe config is loaded once at startup, no hot-reload.
 *
 * @param catId - The cat to check (e.g. 'opus', 'codex', 'opus-45')
 * @param config - Optional config override (for testing)
 */
export function isSessionChainEnabled(catId: CatId | string, config?: CatCafeConfig): boolean {
  const cfg = config ?? getCachedConfig();
  if (!cfg) return true; // Config unreadable → default enabled (Cloud P1 fix)
  const id = catId as string;
  for (const breed of cfg.breeds) {
    for (const variant of breed.variants) {
      const resolvedCatId = variant.catId ?? breed.catId;
      if (resolvedCatId !== id) continue;
      if (variant.sessionChain !== undefined) return variant.sessionChain;
      return breed.features?.sessionChain !== false;
    }
  }
  return true; // Unknown cat → default enabled
}

// ── F33 Phase 2: Session Strategy from config ─────────────────────────

/**
 * Get session strategy config from cat-config.json for a cat.
 * Returns undefined if not configured (caller falls back to code defaults).
 *
 * F33 Phase 2: Same lookup pattern as isSessionChainEnabled — catId → breed → features.
 */
export function getConfigSessionStrategy(
  catId: string,
  config?: CatCafeConfig,
): CatFeatures['sessionStrategy'] | undefined {
  const cfg = config ?? getCachedConfig();
  if (!cfg) return undefined;

  if (!_catIdToBreed || _catIdToBreedSource !== cfg) {
    _catIdToBreed = buildCatIdToBreedIndex(cfg);
    _catIdToBreedSource = cfg;
  }

  const breed = _catIdToBreed.get(catId);
  if (!breed) return undefined;

  // features.sessionStrategy is Zod-validated at load time
  return breed.features?.sessionStrategy;
}

/**
 * Get Mission Hub self-claim scope from cat-config.json for a cat.
 * Defaults to 'disabled' when not configured.
 */
export function getMissionHubSelfClaimScope(catId: string, config?: CatCafeConfig): MissionHubSelfClaimScope {
  const cfg = config ?? getCachedConfig();
  if (!cfg) return DEFAULT_MISSION_HUB_SELF_CLAIM_SCOPE;

  if (!_catIdToBreed || _catIdToBreedSource !== cfg) {
    _catIdToBreed = buildCatIdToBreedIndex(cfg);
    _catIdToBreedSource = cfg;
  }

  const breed = _catIdToBreed.get(catId);
  if (!breed) return DEFAULT_MISSION_HUB_SELF_CLAIM_SCOPE;

  return breed.features?.missionHub?.selfClaimScope ?? DEFAULT_MISSION_HUB_SELF_CLAIM_SCOPE;
}

// ── F32-b: Default cat resolution ─────────────────────────────────────

let _defaultCatId: CatId | null = null;
/** F154 AC-A4: Runtime override for default cat (set via Hub API, owner-gated). */
let _runtimeDefaultCatId: CatId | null = null;

/**
 * Get the default cat ID.
 * Priority: runtime override (F154) → breeds[0].defaultVariantId (F32-b R4).
 * Used as ultimate fallback in AgentRouter when no mentions/participants/preferredCats.
 */
export function getDefaultCatId(): CatId {
  if (_runtimeDefaultCatId) return _runtimeDefaultCatId;
  if (_defaultCatId) return _defaultCatId;

  const config = getCachedConfig();
  const firstBreed = config?.breeds[0];
  if (firstBreed) {
    const defaultVariant = firstBreed.variants.find((v) => v.id === firstBreed.defaultVariantId);
    // variant has independent catId → use it; otherwise inherit breed's
    _defaultCatId = createCatId(defaultVariant?.catId ?? firstBreed.catId);
    return _defaultCatId;
  }

  // Ultimate fallback (should not trigger — config always has at least 1 breed)
  return createCatId('opus');
}

/** F154 AC-A4: Set runtime default cat override. Owner-gated at the API layer. */
export function setRuntimeDefaultCatId(catId: string): void {
  _runtimeDefaultCatId = createCatId(catId);
}

/** F154 AC-A4: Clear runtime override — falls back to breeds[0]. */
export function clearRuntimeDefaultCatId(): void {
  _runtimeDefaultCatId = null;
}

/** F154 AC-A4: Check whether a runtime override is active. */
export function hasRuntimeDefaultCatOverride(): boolean {
  return _runtimeDefaultCatId !== null;
}

/** Unified owner userId: configured env or single-user fallback. */
export function getOwnerUserId(): string {
  return process.env.DEFAULT_OWNER_USER_ID?.trim() || 'default-user';
}

// ── Variant CLI effort accessor ──────────────────────────────────────

/** catId → variant index (lazy, rebuilt on config change) */
let _catIdToVariant: Map<string, CatVariant> | null = null;
let _catIdToVariantSource: CatCafeConfig | null = null;

function buildCatIdToVariantIndex(config: CatCafeConfig): Map<string, CatVariant> {
  const index = new Map<string, CatVariant>();
  for (const breed of config.breeds) {
    for (const variant of breed.variants) {
      const catId = variant.catId ?? breed.catId;
      index.set(catId, variant);
    }
  }
  return index;
}

/** Effort level union across all CLI providers */
export type CliEffortLevel = 'low' | 'medium' | 'high' | 'max' | 'xhigh';

/**
 * Get CLI effort level for a cat from cat-config.json.
 * Default when not configured:
 *   claude (anthropic): 'max'
 *   codex (openai):     'xhigh'
 *   others:             'high'
 */
export function getCatEffort(catId: string, config?: CatCafeConfig, fallbackProvider?: ClientId): CliEffortLevel {
  const cfg = config ?? getCachedConfig();
  if (!cfg) {
    const normalized = normalizeCliEffortForProvider(fallbackProvider ?? 'anthropic', undefined);
    return normalized ?? 'high';
  }

  if (!_catIdToVariant || _catIdToVariantSource !== cfg) {
    _catIdToVariant = buildCatIdToVariantIndex(cfg);
    _catIdToVariantSource = cfg;
  }

  const variant = _catIdToVariant.get(catId);
  if (variant?.cli?.effort) {
    // Defense-in-depth: validate persisted effort against current provider.
    // Stale cross-provider values (e.g. 'max' on openai) are cleaned at write
    // time, but historical data may still contain them.
    const provider = variant.clientId ?? fallbackProvider;
    if (provider) {
      const validated = normalizeCliEffortForProvider(provider, variant.cli.effort);
      if (validated) return validated;
      // Invalid for this provider — fall through to provider default below
    } else {
      return variant.cli.effort;
    }
  }

  // Client-aware defaults: use variant's clientId if found, otherwise fallbackProvider
  const effectiveProvider = variant?.clientId ?? fallbackProvider;
  if (effectiveProvider) {
    const normalized = normalizeCliEffortForProvider(effectiveProvider, undefined);
    if (normalized) return normalized;
  }
  return 'high';
}

export interface CatContextWindowConfig {
  contextWindow: number;
  autoCompactTokenLimit: number;
}

export function getCatContextWindowConfig(catId: string): CatContextWindowConfig | undefined {
  const cfg = getCachedConfig();
  if (!cfg) return undefined;

  if (!_catIdToVariant || _catIdToVariantSource !== cfg) {
    _catIdToVariant = buildCatIdToVariantIndex(cfg);
    _catIdToVariantSource = cfg;
  }

  const variant = _catIdToVariant.get(catId);
  if (!variant?.cli?.contextWindow) return undefined;
  return {
    contextWindow: variant.cli.contextWindow,
    autoCompactTokenLimit: variant.cli.autoCompactTokenLimit ?? Math.floor(variant.cli.contextWindow * 0.88),
  };
}

// ── F149: ACP config accessor (raw variant field, not in CatConfig type) ──────

export interface AcpVariantConfig {
  command: string;
  startupArgs: string[];
  mcpWhitelist?: string[];
  supportsMultiplexing?: boolean;
  /** Phase C: optional pool config overrides */
  pool?: {
    maxLiveProcesses?: number;
    idleTtlMs?: number;
  };
}

/**
 * Get ACP config for a cat from the raw cat-config.json variant.
 * Returns undefined if the variant has no `acp` section (= use legacy CLI).
 * Reads raw JSON because `acp` is not in the typed CatConfig (intentionally).
 */
export function getAcpConfig(catId: string): AcpVariantConfig | undefined {
  try {
    const templatePath = process.env.CAT_TEMPLATE_PATH ?? DEFAULT_CAT_TEMPLATE_PATH;
    const projectRoot = dirname(templatePath);
    const catalogRaw = readCatCatalogRaw(projectRoot);
    let raw: string;
    if (catalogRaw !== null) {
      const baseRaw = readTemplate(templatePath);
      const baseJson = JSON.parse(baseRaw) as Record<string, unknown>;
      const catalogJson = JSON.parse(catalogRaw) as Record<string, unknown>;
      raw = JSON.stringify(deepMergeConfig(baseJson, catalogJson));
    } else {
      raw = readTemplate(templatePath);
    }
    const json = JSON.parse(raw) as {
      breeds?: Array<{ catId?: string; variants?: Array<{ catId?: string; acp?: AcpVariantConfig }> }>;
    };
    for (const breed of json.breeds ?? []) {
      for (const variant of breed.variants ?? []) {
        const resolvedCatId = variant.catId ?? breed.catId;
        if (resolvedCatId === catId && variant.acp) return variant.acp;
      }
    }
  } catch {
    // Config unreadable → no ACP config
  }
  return undefined;
}

/** Reset cached config (for testing) */
export function _resetCachedConfig(): void {
  _cachedConfig = null;
  _configLoadFailed = false;
  _catIdToBreed = null;
  _catIdToBreedSource = null;
  _catIdToVariant = null;
  _catIdToVariantSource = null;
  _defaultCatId = null;
  _cachedRoster = null;
  _cachedReviewPolicy = null;
  _cachedCoCreator = null;
}

// ── F032: Roster + ReviewPolicy accessors ──────────────────────────────

let _cachedRoster: Roster | null = null;
let _cachedReviewPolicy: ReviewPolicy | null = null;

/** Default review policy if not configured (v1 config) */
const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  requireDifferentFamily: true,
  preferActiveInThread: true,
  preferLead: true,
  excludeUnavailable: true,
};
const DEFAULT_MISSION_HUB_SELF_CLAIM_SCOPE: MissionHubSelfClaimScope = 'disabled';

/**
 * Get roster from config. Returns empty object for v1 configs.
 * F032: Used by reviewer matching to check roles, availability, family.
 */
export function getRoster(config?: CatCafeConfig): Roster {
  if (_cachedRoster && !config) return _cachedRoster;

  const cfg = config ?? getCachedConfig();
  if (!cfg) return {};

  // v1 config has no roster
  if (cfg.version === 1) return {};

  // v2 config has roster — TypeScript narrows type after version check
  _cachedRoster = cfg.roster;
  return _cachedRoster;
}

/**
 * Get review policy from config. Returns defaults for v1 configs.
 * F032: Used by reviewer matching to determine matching strategy.
 */
export function getReviewPolicy(config?: CatCafeConfig): ReviewPolicy {
  if (_cachedReviewPolicy && !config) return _cachedReviewPolicy;

  const cfg = config ?? getCachedConfig();
  if (!cfg) return DEFAULT_REVIEW_POLICY;

  // v1 config has no reviewPolicy → use defaults
  if (cfg.version === 1) return DEFAULT_REVIEW_POLICY;

  // v2 config has reviewPolicy — TypeScript narrows type after version check
  _cachedReviewPolicy = cfg.reviewPolicy;
  return _cachedReviewPolicy;
}

/**
 * Check if a cat is available (has quota).
 * F032: 铲屎官 40 美刀教训 — 没猫粮的猫不要找！
 */
export function isCatAvailable(catId: string, config?: CatCafeConfig): boolean {
  const roster = getRoster(config);
  const entry = roster[catId];
  // If not in roster, assume available (backward compat)
  return entry?.available !== false;
}

/**
 * Get a cat's family from roster.
 * F032: Used for "different family" rule in reviewer matching.
 */
export function getCatFamily(catId: string, config?: CatCafeConfig): string | undefined {
  const roster = getRoster(config);
  return roster[catId]?.family;
}

/**
 * Check if a cat has a specific role.
 * F032: Used to check if a cat can be a reviewer, architect, etc.
 */
export function catHasRole(catId: string, role: string, config?: CatCafeConfig): boolean {
  const roster = getRoster(config);
  const entry = roster[catId];
  return entry?.roles.includes(role) ?? false;
}

/**
 * Check if a cat is the lead of its family.
 * F032: Used for "prefer lead" rule in reviewer matching.
 */
export function isCatLead(catId: string, config?: CatCafeConfig): boolean {
  const roster = getRoster(config);
  return roster[catId]?.lead ?? false;
}

// ── F067: Co-Creator config accessor ────────────────────────────────

/** Default co-creator mention patterns (backward compat when not configured) */
const DEFAULT_CO_CREATOR_MENTION_PATTERNS = ['@co-creator', '@铲屎官'];

let _cachedCoCreator: CoCreatorConfig | null = null;

/**
 * Get coCreator config from cat-config.json.
 * Returns a default config with @co-creator/@铲屎官 patterns when not configured.
 */
export function getCoCreatorConfig(config?: CatCafeConfig): CoCreatorConfig {
  if (_cachedCoCreator && !config) return _cachedCoCreator;

  const cfg = config ?? getCachedConfig();

  // v1 config or no coCreator → return defaults
  if (!cfg || cfg.version === 1 || !cfg.coCreator) {
    return { name: '铲屎官', aliases: [], mentionPatterns: DEFAULT_CO_CREATOR_MENTION_PATTERNS };
  }

  _cachedCoCreator = cfg.coCreator;
  return _cachedCoCreator;
}

/**
 * Get all co-creator mention patterns (lowercased, with @ prefix).
 * Always includes @co-creator and @铲屎官 as fallback patterns in addition to configured ones.
 */
export function getCoCreatorMentionPatterns(config?: CatCafeConfig): readonly string[] {
  const coCreator = getCoCreatorConfig(config);
  const patterns = new Set(coCreator.mentionPatterns.map((p: string) => p.toLowerCase()));
  // Always include legacy patterns for backward compat
  for (const p of DEFAULT_CO_CREATOR_MENTION_PATTERNS) patterns.add(p);
  return [...patterns];
}
