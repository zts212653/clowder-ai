import { join, resolve } from 'node:path';
import type { CatBreed, CatCafeConfig, CatColor, CatProvider, CatVariant, CliConfig, ContextBudget } from '@cat-cafe/shared';
import { createCatId } from '@cat-cafe/shared';
import { clearBudgetCache } from './cat-budgets.js';
import { _resetCachedConfig, loadCatConfig } from './cat-config-loader.js';
import { clearVoiceCache } from './cat-voices.js';
import { bootstrapCatCatalog, readCatCatalog, writeCatCatalog } from './cat-catalog-store.js';

export interface RuntimeCatInput {
  catId: string;
  breedId?: string;
  name: string;
  displayName: string;
  nickname?: string;
  avatar: string;
  color: CatColor;
  mentionPatterns: string[];
  providerProfileId?: string;
  roleDescription: string;
  personality?: string;
  provider: CatProvider;
  defaultModel: string;
  mcpSupport: boolean;
  cli: CliConfig;
  commandArgs?: string[];
  contextBudget?: ContextBudget;
}

export interface RuntimeCatUpdate {
  name?: string;
  displayName?: string;
  nickname?: string;
  avatar?: string;
  color?: CatColor;
  mentionPatterns?: string[];
  providerProfileId?: string;
  roleDescription?: string;
  personality?: string;
  provider?: CatProvider;
  defaultModel?: string;
  mcpSupport?: boolean;
  cli?: CliConfig;
  commandArgs?: string[];
  contextBudget?: ContextBudget;
}

interface BreedVariantLocation {
  breedIndex: number;
  variantIndex: number;
  breed: CatBreed;
  variant: CatVariant;
  resolvedCatId: string;
  isDefaultVariant: boolean;
}

function resolveTemplatePath(projectRoot: string): string {
  const envPath = process.env.CAT_TEMPLATE_PATH?.trim();
  if (envPath) {
    const absoluteEnvPath = resolve(envPath);
    if (absoluteEnvPath.startsWith(resolve(projectRoot))) return absoluteEnvPath;
  }
  return join(projectRoot, 'cat-template.json');
}

function normalizeMentionPatterns(catId: string, mentionPatterns: readonly string[]): string[] {
  const values = mentionPatterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => (pattern.startsWith('@') ? pattern : `@${pattern}`));
  const unique = Array.from(new Set(values));
  const canonical = `@${catId}`;
  if (!unique.includes(canonical)) unique.unshift(canonical);
  return unique;
}

function readOrBootstrapCatalog(projectRoot: string): CatCafeConfig {
  const templatePath = resolveTemplatePath(projectRoot);
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

function writeAndValidateCatalog(projectRoot: string, catalog: unknown): CatCafeConfig {
  writeCatCatalog(projectRoot, catalog as CatCafeConfig);
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
    variants: [
      {
        id: variantId,
        provider: input.provider,
        defaultModel: input.defaultModel,
        mcpSupport: input.mcpSupport,
        cli: input.cli,
        ...(input.providerProfileId != null && input.providerProfileId.trim().length > 0
          ? { providerProfileId: input.providerProfileId.trim() }
          : {}),
        ...(input.commandArgs && input.commandArgs.length > 0 ? { commandArgs: input.commandArgs } : {}),
        ...(input.contextBudget ? { contextBudget: input.contextBudget } : {}),
        ...(input.personality != null && input.personality.trim().length > 0 ? { personality: input.personality } : {}),
      },
    ],
  } as unknown as CatBreed;
}

function cloneCatalog(catalog: CatCafeConfig): Record<string, any> {
  return structuredClone(catalog) as Record<string, any>;
}

export function readRuntimeCatCatalog(projectRoot: string): CatCafeConfig {
  return readOrBootstrapCatalog(projectRoot);
}

export function createRuntimeCat(projectRoot: string, input: RuntimeCatInput): CatCafeConfig {
  const catalog = cloneCatalog(readOrBootstrapCatalog(projectRoot));
  if (findBreedVariant(catalog as unknown as CatCafeConfig, input.catId)) {
    throw new Error(`Cat "${input.catId}" already exists in runtime catalog`);
  }
  catalog.breeds = [...catalog.breeds, createBreedFromInput(input) as unknown as Record<string, any>];
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
  if (patch.roleDescription !== undefined) breed.roleDescription = patch.roleDescription;

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

  if (patch.providerProfileId !== undefined) {
    if (patch.providerProfileId && patch.providerProfileId.trim().length > 0) {
      variant.providerProfileId = patch.providerProfileId.trim();
    } else {
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
  if (patch.provider !== undefined) variant.provider = patch.provider;
  if (patch.defaultModel !== undefined) variant.defaultModel = patch.defaultModel;
  if (patch.mcpSupport !== undefined) variant.mcpSupport = patch.mcpSupport;
  if (patch.cli !== undefined) variant.cli = patch.cli;
  if (patch.contextBudget !== undefined) variant.contextBudget = patch.contextBudget;
  if (patch.commandArgs !== undefined) {
    if (patch.commandArgs.length > 0) {
      variant.commandArgs = patch.commandArgs;
    } else {
      delete variant.commandArgs;
    }
  }

  return writeAndValidateCatalog(projectRoot, catalog);
}

export function deleteRuntimeCat(projectRoot: string, catId: string): CatCafeConfig {
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
