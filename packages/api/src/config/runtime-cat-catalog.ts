import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  CatBreed,
  CatCafeConfig,
  CatColor,
  CatProvider,
  CatVariant,
  CliConfig,
  CoCreatorConfig,
  ContextBudget,
} from '@cat-cafe/shared';
import { CAT_CONFIGS, createCatId } from '@cat-cafe/shared';
import { clearBudgetCache } from './cat-budgets.js';
import { bootstrapCatCatalog, readCatCatalog, resolveCatCatalogPath } from './cat-catalog-store.js';
import { _resetCachedConfig, loadCatConfig, toAllCatConfigs } from './cat-config-loader.js';
import { clearVoiceCache } from './cat-voices.js';
import { resolveProjectTemplatePath } from './project-template-path.js';

export interface RuntimeCatInput {
  catId: string;
  breedId?: string;
  name: string;
  displayName: string;
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
  provider: CatProvider;
  defaultModel: string;
  mcpSupport: boolean;
  cli: CliConfig;
  commandArgs?: string[];
  cliConfigArgs?: string[];
  contextBudget?: ContextBudget;
  ocProviderName?: string;
}

export interface RuntimeCatUpdate {
  name?: string;
  displayName?: string;
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
  provider?: CatProvider;
  defaultModel?: string;
  mcpSupport?: boolean;
  cli?: CliConfig;
  commandArgs?: string[];
  cliConfigArgs?: string[];
  contextBudget?: ContextBudget | null;
  ocProviderName?: string | null;
  available?: boolean;
}

export interface RuntimeCoCreatorUpdate {
  name?: string;
  aliases?: string[];
  mentionPatterns?: string[];
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

function readOrBootstrapCatalog(projectRoot: string): CatCafeConfig {
  const templatePath = resolveProjectTemplatePath(projectRoot);
  bootstrapCatCatalog(projectRoot, templatePath);
  const catalog = readCatCatalog(projectRoot);
  if (!catalog) {
    throw new Error(`Runtime cat catalog missing at ${projectRoot}`);
  }
  return catalog;
}

function isSeedCat(projectRoot: string, catId: string): boolean {
  try {
    const templatePath = resolveProjectTemplatePath(projectRoot);
    const seedCats = toAllCatConfigs(loadCatConfig(templatePath));
    return Object.hasOwn(seedCats, catId);
  } catch {
    return Object.hasOwn(CAT_CONFIGS, catId);
  }
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
        provider: input.provider,
        defaultModel: input.defaultModel,
        mcpSupport: input.mcpSupport,
        cli: input.cli,
        ...(input.accountRef != null && input.accountRef.trim().length > 0
          ? { accountRef: input.accountRef.trim(), providerProfileId: input.accountRef.trim() }
          : {}),
        ...(input.commandArgs && input.commandArgs.length > 0 ? { commandArgs: input.commandArgs } : {}),
        ...(input.cliConfigArgs && input.cliConfigArgs.length > 0 ? { cliConfigArgs: input.cliConfigArgs } : {}),
        ...(input.ocProviderName ? { ocProviderName: input.ocProviderName } : {}),
        ...(input.contextBudget ? { contextBudget: input.contextBudget } : {}),
        ...(input.personality != null && input.personality.trim().length > 0 ? { personality: input.personality } : {}),
        ...(input.teamStrengths != null && input.teamStrengths.trim().length > 0
          ? { teamStrengths: input.teamStrengths.trim() }
          : {}),
        ...(input.caution !== undefined
          ? { caution: input.caution && input.caution.trim().length > 0 ? input.caution.trim() : null }
          : {}),
        ...(input.strengths ? { strengths: input.strengths } : {}),
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

  if (patch.name !== undefined) breed.name = patch.name;
  if (patch.nickname !== undefined) {
    if (patch.nickname && patch.nickname.trim().length > 0) {
      breed.nickname = patch.nickname.trim();
    } else {
      delete breed.nickname;
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
    if (located.isDefaultVariant) {
      breed.displayName = patch.displayName;
      delete variant.displayName;
    } else {
      variant.displayName = patch.displayName;
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
      const normalizedAccountRef = patch.accountRef.trim();
      variant.accountRef = normalizedAccountRef;
      variant.providerProfileId = normalizedAccountRef;
    } else {
      delete variant.accountRef;
      delete variant.providerProfileId;
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
  if (patch.provider !== undefined) variant.provider = patch.provider;
  if (patch.defaultModel !== undefined) variant.defaultModel = patch.defaultModel;
  if (patch.mcpSupport !== undefined) variant.mcpSupport = patch.mcpSupport;
  if (patch.cli !== undefined) variant.cli = patch.cli;
  if (patch.contextBudget !== undefined) {
    if (patch.contextBudget) {
      variant.contextBudget = patch.contextBudget;
    } else {
      delete variant.contextBudget;
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
  if (patch.ocProviderName !== undefined) {
    if (patch.ocProviderName) {
      variant.ocProviderName = patch.ocProviderName;
    } else {
      delete variant.ocProviderName;
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
    name: '铲屎官',
    aliases: [],
    mentionPatterns: ['@co-creator', '@铲屎官'],
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
    ...(typeof nextOwner.avatar === 'string' ? { avatar: nextOwner.avatar } : {}),
    ...(nextOwner.color ? { color: nextOwner.color as CatColor } : {}),
  };

  catalog.coCreator = normalizedOwner;
  return writeAndValidateCatalog(projectRoot, catalog);
}

export function deleteRuntimeCat(projectRoot: string, catId: string): CatCafeConfig {
  if (isSeedCat(projectRoot, catId)) {
    throw new Error(`Cannot delete seed cat "${catId}" from runtime catalog`);
  }
  const catalog = cloneCatalog(readOrBootstrapCatalog(projectRoot));
  const located = findBreedVariant(catalog as unknown as CatCafeConfig, catId);
  if (!located) {
    throw new Error(`Cat "${catId}" not found in runtime catalog`);
  }

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

  return writeAndValidateCatalog(projectRoot, catalog);
}

export function refreshRuntimeCatCatalogCaches(): void {
  invalidateRuntimeCatalogCaches();
}
