import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  CatBreed,
  CatCafeConfig,
  CatColor,
  CatVariant,
  CliConfig,
  ClientId,
  CoCreatorConfig,
  ContextBudget,
  VoiceConfig,
} from '@cat-cafe/shared';
import { createCatId } from '@cat-cafe/shared';
import { clearBudgetCache } from './cat-budgets.js';
import { bootstrapCatCatalog, readCatCatalog, resolveCatCatalogPath } from './cat-catalog-store.js';
import type { AcpVariantConfig } from './cat-config-loader.js';
import { _resetCachedConfig, loadCatConfig, toAllCatConfigs } from './cat-config-loader.js';
import { clearVoiceCache } from './cat-voices.js';
import { resolveProjectTemplatePath } from './project-template-path.js';
import { addTemplateVariantTombstone, type TemplateVariantTombstoneInput } from './template-variant-tombstones.js';

export interface RuntimeCatInput {
  catId: string;
  breedId?: string;
  name: string;
  displayName: string;
  variantLabel?: string;
  nickname?: string;
  avatar: string;
  color: CatColor;
  mentionPatterns: string[];
  accountRef?: string;
  roleDescription: string;
  personality?: string;
  teamStrengths?: string;
  caution?: string | null;
  strengths?: string[];
  sessionChain?: boolean;
  clientId: ClientId;
  defaultModel: string;
  mcpSupport: boolean;
  /** F247 KD-17: cloud-only cats (Remote MCP) omit cli to skip local dispatch.
   * When cli is absent, mention routing queues the mention without spawning a CLI. */
  cli?: CliConfig;
  commandArgs?: string[];
  cliConfigArgs?: string[];
  contextBudget?: ContextBudget;
  voiceConfig?: VoiceConfig;
  /** clowder-ai#340 P5: Model provider name (renamed from ocProviderName). */
  provider?: string;
  /** F161: ACP transport config — presence triggers ACP transport instead of CLI. */
  acp?: AcpVariantConfig;
}

export interface RuntimeCatUpdate {
  name?: string;
  displayName?: string;
  variantLabel?: string | null;
  nickname?: string;
  avatar?: string;
  color?: CatColor;
  mentionPatterns?: string[];
  accountRef?: string | null;
  roleDescription?: string;
  personality?: string;
  teamStrengths?: string;
  caution?: string | null;
  strengths?: string[];
  sessionChain?: boolean;
  clientId?: ClientId;
  defaultModel?: string;
  mcpSupport?: boolean;
  /** F247 KD-17: cli null to remove (cloud-only mode), CliConfig to update, undefined to skip. */
  cli?: CliConfig | null;
  commandArgs?: string[];
  cliConfigArgs?: string[];
  contextBudget?: ContextBudget | null;
  voiceConfig?: VoiceConfig | null;
  /** clowder-ai#340 P5: Model provider name (renamed from ocProviderName). */
  provider?: string | null;
  available?: boolean;
  /** F161: ACP transport config — null to remove, undefined to skip. */
  acp?: AcpVariantConfig | null;
}

export interface RuntimeCoCreatorUpdate {
  name?: string;
  aliases?: string[];
  mentionPatterns?: string[];
  timeZone?: string;
  avatar?: string | null;
  color?: CatColor | null;
}

interface BreedVariantLocation {
  breedIndex: number;
  variantIndex: number;
  breed: CatBreed;
  variant: CatVariant;
  resolvedCatId: string;
  isDefaultVariant: boolean;
}

function normalizeMentionPatterns(_catId: string, mentionPatterns: readonly string[]): string[] {
  const values = mentionPatterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => (pattern.startsWith('@') ? pattern : `@${pattern}`));
  return Array.from(new Set(values));
}

function normalizeCoCreatorMentionPatterns(mentionPatterns: readonly string[]): string[] {
  const values = mentionPatterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => (pattern.startsWith('@') ? pattern : `@${pattern}`));
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findTemplateVariantTombstoneInput(projectRoot: string, catId: string): TemplateVariantTombstoneInput | null {
  let templateRaw: string;
  try {
    templateRaw = readFileSync(resolveProjectTemplatePath(projectRoot), 'utf-8');
  } catch {
    return null;
  }

  let templateJson: unknown;
  try {
    templateJson = JSON.parse(templateRaw);
  } catch {
    return null;
  }

  if (!isRecord(templateJson) || !Array.isArray(templateJson.breeds)) return null;
  for (const breedUnknown of templateJson.breeds) {
    if (!isRecord(breedUnknown)) continue;
    if (typeof breedUnknown.id !== 'string') continue;
    const breedCatId = typeof breedUnknown.catId === 'string' ? breedUnknown.catId : undefined;
    const variants = Array.isArray(breedUnknown.variants) ? breedUnknown.variants : [];
    for (const variantUnknown of variants) {
      if (!isRecord(variantUnknown)) continue;
      if (typeof variantUnknown.id !== 'string') continue;
      const resolvedCatId = typeof variantUnknown.catId === 'string' ? variantUnknown.catId : breedCatId;
      if (resolvedCatId !== catId) continue;
      return {
        breedId: breedUnknown.id,
        variantId: variantUnknown.id,
        catId: resolvedCatId,
      };
    }
  }
  return null;
}

function readOrBootstrapCatalog(projectRoot: string): CatCafeConfig {
  const templatePath = resolveProjectTemplatePath(projectRoot);
  bootstrapCatCatalog(projectRoot, templatePath);
  const catalog = readCatCatalog(projectRoot);
  if (!catalog) {
    throw new Error(`Runtime cat catalog missing at ${projectRoot}`);
  }
  return catalog;
}

function invalidateRuntimeCatalogCaches(): void {
  _resetCachedConfig();
  clearBudgetCache();
  clearVoiceCache();
}

function validatePersistedCatalog(projectRoot: string): CatCafeConfig {
  invalidateRuntimeCatalogCaches();
  return loadCatConfig(join(projectRoot, '.cat-cafe', 'cat-catalog.json'));
}

function assertUniqueMentionAliases(catalog: CatCafeConfig): void {
  const aliasHolders = new Map<string, string>();
  for (const [catId, config] of Object.entries(toAllCatConfigs(catalog))) {
    for (const mentionPattern of config.mentionPatterns) {
      const trimmed = mentionPattern.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      const holder = aliasHolders.get(key);
      if (holder && holder !== catId) {
        throw new Error(`mention alias "${trimmed}" is already used by cat "${holder}"`);
      }
      aliasHolders.set(key, catId);
    }
  }

  const coCreatorMentionPatterns = catalog.version === 2 ? (catalog.coCreator?.mentionPatterns ?? []) : [];
  for (const mentionPattern of coCreatorMentionPatterns) {
    const trimmed = mentionPattern.trim();
    if (!trimmed) continue;
    const holder = aliasHolders.get(trimmed.toLowerCase());
    if (holder) {
      throw new Error(`co-creator mention alias "${trimmed}" conflicts with cat "${holder}"`);
    }
  }
}

function writeAndValidateCatalog(projectRoot: string, catalog: unknown): CatCafeConfig {
  const candidate = catalog as CatCafeConfig;
  assertUniqueMentionAliases(candidate);
  const catalogPath = resolveCatCatalogPath(projectRoot);
  const tempPath = `${catalogPath}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf-8');
  try {
    loadCatConfig(tempPath);
    renameSync(tempPath, catalogPath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
  return validatePersistedCatalog(projectRoot);
}

function findBreedVariant(catalog: CatCafeConfig, catId: string): BreedVariantLocation | null {
  for (const [breedIndex, breed] of catalog.breeds.entries()) {
    for (const [variantIndex, variant] of breed.variants.entries()) {
      const resolvedCatId = variant.catId ?? breed.catId;
      if (resolvedCatId !== catId) continue;
      return {
        breedIndex,
        variantIndex,
        breed,
        variant,
        resolvedCatId,
        isDefaultVariant: variant.id === breed.defaultVariantId,
      };
    }
  }
  return null;
}

function createBreedFromInput(input: RuntimeCatInput): CatBreed {
  const variantId = `${input.catId}-default`;
  return {
    id: input.breedId?.trim() || input.catId,
    catId: createCatId(input.catId),
    name: input.name,
    displayName: input.displayName,
    ...(input.nickname != null && input.nickname.trim().length > 0 ? { nickname: input.nickname.trim() } : {}),
    avatar: input.avatar,
    color: input.color,
    mentionPatterns: normalizeMentionPatterns(input.catId, input.mentionPatterns),
    roleDescription: input.roleDescription,
    defaultVariantId: variantId,
    ...(input.sessionChain !== undefined ? { features: { sessionChain: input.sessionChain } } : {}),
    variants: [
      {
        id: variantId,
        clientId: input.clientId,
        ...(input.variantLabel != null && input.variantLabel.trim().length > 0
          ? { variantLabel: input.variantLabel.trim() }
          : {}),
        defaultModel: input.defaultModel,
        mcpSupport: input.mcpSupport,
        // F247 KD-17: omit cli for cloud-only cats (Remote MCP, no local dispatch).
        ...(input.cli ? { cli: input.cli } : {}),
        ...(input.accountRef != null && input.accountRef.trim().length > 0
          ? { accountRef: input.accountRef.trim() }
          : {}),
        ...(input.commandArgs && input.commandArgs.length > 0 ? { commandArgs: input.commandArgs } : {}),
        ...(input.cliConfigArgs && input.cliConfigArgs.length > 0 ? { cliConfigArgs: input.cliConfigArgs } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.contextBudget ? { contextBudget: input.contextBudget } : {}),
        ...(input.voiceConfig !== undefined ? { voiceConfig: input.voiceConfig } : {}),
        ...(input.personality != null && input.personality.trim().length > 0 ? { personality: input.personality } : {}),
        ...(input.teamStrengths != null && input.teamStrengths.trim().length > 0
          ? { teamStrengths: input.teamStrengths.trim() }
          : {}),
        ...(input.caution !== undefined
          ? { caution: input.caution && input.caution.trim().length > 0 ? input.caution.trim() : null }
          : {}),
        ...(input.strengths ? { strengths: input.strengths } : {}),
        ...(input.acp ? { acp: input.acp } : {}),
      },
    ],
  } as unknown as CatBreed;
}

function cloneCatalog(catalog: CatCafeConfig): Record<string, any> {
  return structuredClone(catalog) as Record<string, any>;
}

function buildDefaultRuntimeRosterEntry(
  catId: string,
  family: string,
  displayName: string,
  available: boolean,
): { family: string; roles: string[]; lead: false; available: boolean; evaluation: string } {
  return {
    family,
    roles: ['assistant'],
    lead: false,
    available,
    evaluation: `${displayName} runtime member`,
  };
}

export function readRuntimeCatCatalog(projectRoot: string): CatCafeConfig {
  return readOrBootstrapCatalog(projectRoot);
}

export function createRuntimeCat(projectRoot: string, input: RuntimeCatInput): CatCafeConfig {
  const catalog = cloneCatalog(readOrBootstrapCatalog(projectRoot));
  if (findBreedVariant(catalog as unknown as CatCafeConfig, input.catId)) {
    throw new Error(`Cat "${input.catId}" already exists in runtime catalog`);
  }
  const nextBreed = createBreedFromInput(input) as unknown as Record<string, any>;
  catalog.breeds = [...catalog.breeds, nextBreed];
  if (catalog.version === 2) {
    catalog.roster = {
      ...catalog.roster,
      [input.catId]: buildDefaultRuntimeRosterEntry(
        input.catId,
        String(nextBreed.id ?? input.catId),
        String(nextBreed.displayName ?? nextBreed.name ?? input.catId),
        true,
      ),
    };
  }
  return writeAndValidateCatalog(projectRoot, catalog);
}

export function updateRuntimeCat(projectRoot: string, catId: string, patch: RuntimeCatUpdate): CatCafeConfig {
  const catalog = cloneCatalog(readOrBootstrapCatalog(projectRoot));
  const located = findBreedVariant(catalog as unknown as CatCafeConfig, catId);
  if (!located) {
    throw new Error(`Cat "${catId}" not found in runtime catalog`);
  }

  const breed = catalog.breeds[located.breedIndex] as Record<string, any>;
  const variant = breed.variants[located.variantIndex] as Record<string, any>;
  const shouldWriteBreedIdentity = located.isDefaultVariant && breed.variants.length === 1;

  if (patch.name !== undefined) {
    if (shouldWriteBreedIdentity) {
      breed.name = patch.name;
      delete variant.name;
    } else {
      variant.name = patch.name;
    }
  }
  if (patch.nickname !== undefined) {
    const nickname = patch.nickname.trim();
    if (shouldWriteBreedIdentity) {
      if (nickname.length > 0) {
        breed.nickname = nickname;
      } else {
        delete breed.nickname;
      }
      delete variant.nickname;
    } else if (nickname.length > 0) {
      variant.nickname = nickname;
    } else {
      variant.nickname = null;
    }
  }
  if (patch.roleDescription !== undefined) {
    if (located.isDefaultVariant) {
      variant.roleDescription = patch.roleDescription;
    } else {
      variant.roleDescription = patch.roleDescription;
    }
  }

  if (patch.displayName !== undefined) {
    if (shouldWriteBreedIdentity) {
      breed.displayName = patch.displayName;
      delete variant.displayName;
    } else {
      // Multi-variant breed: keep name/displayName editing independent.
      // toAllCatConfigs resolves `name` as `variant.name ?? variant.displayName ?? breed.name`;
      // if we overwrite variant.displayName without a variant.name override,
      // the resolved name silently follows the new displayName (P2 finding on
      // clowder-ai#1090). Snapshot the currently-resolved name into variant.name
      // so a displayName-only patch cannot alter this member's resolved name.
      // Legacy variants that inherited name via variant.displayName fallback
      // keep that name explicitly on their first displayName edit.
      if (variant.name === undefined) {
        variant.name = variant.displayName ?? breed.name;
      }
      variant.displayName = patch.displayName;
    }
  }

  if (patch.variantLabel !== undefined) {
    if (patch.variantLabel && patch.variantLabel.trim().length > 0) {
      variant.variantLabel = patch.variantLabel.trim();
    } else {
      delete variant.variantLabel;
    }
  }

  if (patch.avatar !== undefined) {
    if (located.isDefaultVariant) {
      breed.avatar = patch.avatar;
      delete variant.avatar;
    } else {
      variant.avatar = patch.avatar;
    }
  }

  if (patch.color !== undefined) {
    if (located.isDefaultVariant) {
      breed.color = patch.color;
      delete variant.color;
    } else {
      variant.color = patch.color;
    }
  }

  if (patch.mentionPatterns !== undefined) {
    const normalized = normalizeMentionPatterns(catId, patch.mentionPatterns);
    if (located.isDefaultVariant) {
      breed.mentionPatterns = normalized;
      delete variant.mentionPatterns;
    } else {
      variant.mentionPatterns = normalized;
    }
  }

  if (patch.accountRef !== undefined) {
    if (patch.accountRef && patch.accountRef.trim().length > 0) {
      variant.accountRef = patch.accountRef.trim();
    } else {
      delete variant.accountRef;
    }
  }
  if (patch.personality !== undefined) {
    if (patch.personality && patch.personality.trim().length > 0) {
      variant.personality = patch.personality;
    } else {
      delete variant.personality;
    }
  }
  if (patch.teamStrengths !== undefined) {
    if (patch.teamStrengths && patch.teamStrengths.trim().length > 0) {
      variant.teamStrengths = patch.teamStrengths.trim();
    } else {
      delete variant.teamStrengths;
    }
  }
  if (patch.caution !== undefined) {
    variant.caution = patch.caution && patch.caution.trim().length > 0 ? patch.caution.trim() : null;
  }
  if (patch.strengths !== undefined) {
    if (patch.strengths.length > 0) {
      variant.strengths = patch.strengths;
    } else {
      delete variant.strengths;
    }
  }
  if (patch.sessionChain !== undefined) {
    if (located.isDefaultVariant) {
      variant.sessionChain = patch.sessionChain;
    } else {
      variant.sessionChain = patch.sessionChain;
    }
  }
  if (patch.clientId !== undefined) variant.clientId = patch.clientId;
  if (patch.defaultModel !== undefined) variant.defaultModel = patch.defaultModel;
  if (patch.mcpSupport !== undefined) variant.mcpSupport = patch.mcpSupport;
  // F247 KD-17: patch.cli === null means remove (cloud-only mode); object means update.
  if (patch.cli !== undefined) {
    if (patch.cli === null) {
      delete variant.cli;
    } else {
      variant.cli = patch.cli;
    }
  }
  if (patch.contextBudget !== undefined) {
    if (patch.contextBudget) {
      variant.contextBudget = patch.contextBudget;
    } else {
      delete variant.contextBudget;
    }
  }
  if (patch.voiceConfig !== undefined) {
    if (patch.voiceConfig) {
      variant.voiceConfig = patch.voiceConfig;
    } else {
      delete variant.voiceConfig;
    }
  }
  if (patch.commandArgs !== undefined) {
    if (patch.commandArgs.length > 0) {
      variant.commandArgs = patch.commandArgs;
    } else {
      delete variant.commandArgs;
    }
  }
  if (patch.cliConfigArgs !== undefined) {
    if (patch.cliConfigArgs.length > 0) {
      variant.cliConfigArgs = patch.cliConfigArgs;
    } else {
      delete variant.cliConfigArgs;
    }
  }
  if (patch.provider !== undefined) {
    if (patch.provider) {
      variant.provider = patch.provider;
    } else {
      delete variant.provider;
    }
  }
  // F161: ACP transport config — null removes it (revert to CLI transport).
  if (patch.acp !== undefined) {
    if (patch.acp) {
      (variant as Record<string, unknown>).acp = patch.acp;
    } else {
      (variant as Record<string, unknown>).acp = null;
    }
  }
  if (patch.available !== undefined && catalog.version === 2) {
    const existingEntry = catalog.roster[catId];
    catalog.roster = {
      ...catalog.roster,
      [catId]: existingEntry
        ? { ...existingEntry, available: patch.available }
        : buildDefaultRuntimeRosterEntry(
            catId,
            String(breed.id ?? catId),
            String(breed.displayName ?? breed.name ?? catId),
            patch.available,
          ),
    };
  }

  return writeAndValidateCatalog(projectRoot, catalog);
}

export function updateRuntimeCoCreator(projectRoot: string, patch: RuntimeCoCreatorUpdate): CatCafeConfig {
  const catalog = cloneCatalog(readOrBootstrapCatalog(projectRoot));
  if (catalog.version !== 2) {
    throw new Error('Owner config requires a version 2 runtime catalog');
  }

  const currentOwner = (catalog.coCreator ?? {
    name: 'co-creator',
    aliases: [],
    mentionPatterns: ['@co-creator', '@co-creator'],
  }) as CoCreatorConfig;

  const nextOwner: Record<string, unknown> = {
    ...currentOwner,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.aliases !== undefined
      ? {
          aliases: Array.from(new Set(patch.aliases.map((alias) => alias.trim()).filter((alias) => alias.length > 0))),
        }
      : {}),
    ...(patch.mentionPatterns !== undefined
      ? {
          mentionPatterns: normalizeCoCreatorMentionPatterns(patch.mentionPatterns),
        }
      : {}),
  };

  if (patch.timeZone !== undefined) {
    nextOwner.timeZone = patch.timeZone.trim();
  }

  if (patch.avatar !== undefined) {
    if (patch.avatar && patch.avatar.trim().length > 0) {
      nextOwner.avatar = patch.avatar.trim();
    } else {
      delete nextOwner.avatar;
    }
  }

  if (patch.color !== undefined) {
    if (patch.color) {
      nextOwner.color = patch.color;
    } else {
      delete nextOwner.color;
    }
  }

  const normalizedOwner: CoCreatorConfig = {
    name: String(nextOwner.name ?? currentOwner.name),
    aliases: Array.isArray(nextOwner.aliases) ? (nextOwner.aliases as string[]) : [...currentOwner.aliases],
    mentionPatterns: Array.isArray(nextOwner.mentionPatterns)
      ? (nextOwner.mentionPatterns as string[])
      : [...currentOwner.mentionPatterns],
    ...(typeof nextOwner.timeZone === 'string' ? { timeZone: nextOwner.timeZone } : {}),
    ...(typeof nextOwner.avatar === 'string' ? { avatar: nextOwner.avatar } : {}),
    ...(nextOwner.color ? { color: nextOwner.color as CatColor } : {}),
  };

  catalog.coCreator = normalizedOwner;
  return writeAndValidateCatalog(projectRoot, catalog);
}

export function deleteRuntimeCat(projectRoot: string, catId: string): CatCafeConfig {
  const catalog = cloneCatalog(readOrBootstrapCatalog(projectRoot));
  const located = findBreedVariant(catalog as unknown as CatCafeConfig, catId);
  if (!located) {
    throw new Error(`Cat "${catId}" not found in runtime catalog`);
  }
  const templateVariantTombstoneInput = findTemplateVariantTombstoneInput(projectRoot, catId);
  const breed = catalog.breeds[located.breedIndex] as Record<string, any>;
  if (breed.variants.length === 1) {
    catalog.breeds = catalog.breeds.filter((_: unknown, index: number) => index !== located.breedIndex);
  } else {
    breed.variants = breed.variants.filter((_: unknown, index: number) => index !== located.variantIndex);
    if (located.isDefaultVariant) {
      breed.defaultVariantId = breed.variants[0]?.id ?? breed.defaultVariantId;
    }
  }

  if (catalog.version === 2 && catId in catalog.roster) {
    const nextRoster = { ...catalog.roster };
    delete nextRoster[catId];
    catalog.roster = nextRoster;
  }

  if (templateVariantTombstoneInput) {
    addTemplateVariantTombstone(catalog as Record<string, unknown>, templateVariantTombstoneInput);
  }

  return writeAndValidateCatalog(projectRoot, catalog);
}

export function refreshRuntimeCatCatalogCaches(): void {
  invalidateRuntimeCatalogCaches();
}
