import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CatCafeConfig, CatColor, ClientId, CoCreatorConfig } from '@cat-cafe/shared';
import { backgroundImageUrlSchema } from '@cat-cafe/shared';
import { planRoleAccountBinding } from '@clowder-ai/agent-access/roles/role-account-binding';
import {
  assertUniqueMentionAliases,
  planRoleCreation,
  planRoleDeletion,
  planRoleUpdate,
  type RuntimeCatInput,
  type RuntimeCatUpdate,
} from '@clowder-ai/agent-access/roles/role-mutations';
import { saveSpan } from '../utils/member-save-diagnostics.js';
import { planAgyAccountBinding } from './agy-account-binding.js';
import { clearBudgetCache } from './cat-budgets.js';
import { readPublishedRoleCatalogSource, readStoredCatCatalog, resolveCatCatalogPath } from './cat-catalog-store.js';
import { _resetCachedConfig, loadCatConfig, parseRawCatConfig, toAllCatConfigs } from './cat-config-loader.js';
import { clearVoiceCache } from './cat-voices.js';
import { planClaudeAccountBinding } from './claude-account-binding.js';
import { coCreatorMentionInputSchema } from './co-creator-mention.js';
import {
  assertCodexMemberMutationReady,
  type CodexBindingSelection,
  planCodexAccountBinding,
} from './codex-account-binding.js';

import { resolveProjectTemplatePath } from './project-template-path.js';
import type { TemplateVariantTombstoneInput } from './template-variant-tombstones.js';
import { writeFileAtomic } from './write-file-atomic.js';

export type { RuntimeCatInput, RuntimeCatUpdate };

const runtimeCatMutationOwner = new AsyncLocalStorage<{ projectRoot: string; active: boolean }>();
const runtimeCatMutationTails = new Map<string, Promise<void>>();

/** Serialize catalog mutations within this API process so retried first-run writes cannot lose a member. */
export async function withRuntimeCatMutationLock<T>(projectRoot: string, operation: () => T): Promise<T> {
  const owner = runtimeCatMutationOwner.getStore();
  if (owner?.active && owner.projectRoot === projectRoot) return operation();
  const scope = { projectRoot, active: true };
  const previous = runtimeCatMutationTails.get(projectRoot) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtimeCatMutationTails.set(projectRoot, current);
  await saveSpan('catalog.queue', () => previous);
  let lockFd: number | undefined;
  const lockPath = `${resolveCatCatalogPath(projectRoot)}.lock`;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    await saveSpan('catalog.file_lock', async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        try {
          lockFd = openSync(lockPath, 'wx');
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          try {
            if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
          } catch {
            // The writer may have released the lock between stat and unlink.
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (lockFd === undefined) throw new Error('Timed out waiting for runtime cat catalog lock');
    });
    return await saveSpan('catalog.write', () => runtimeCatMutationOwner.run(scope, operation));
  } finally {
    scope.active = false;
    if (lockFd !== undefined) {
      closeSync(lockFd);
      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort release; stale locks are reclaimed above.
      }
    }
    release();
    if (runtimeCatMutationTails.get(projectRoot) === current) runtimeCatMutationTails.delete(projectRoot);
  }
}

export interface RuntimeCoCreatorUpdate {
  name?: string;
  nickname?: string | null;
  aliases?: string[];
  mentionPatterns?: string[];
  timeZone?: string;
  avatar?: string | null;
  color?: CatColor | null;
}

function normalizeCoCreatorMentionPatterns(mentionPatterns: readonly string[]): string[] {
  const values = mentionPatterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => coCreatorMentionInputSchema.parse(pattern));
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function findTemplateVariantTombstoneInput(
  projectRoot: string,
  catId: string,
): TemplateVariantTombstoneInput | null {
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
  const candidate = catalog as CatCafeConfig;
  assertUniqueMentionAliases(candidate);
  const catalogPath = resolveCatCatalogPath(projectRoot);
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileAtomic(catalogPath, `${JSON.stringify(candidate, null, 2)}\n`, {
    verify: (tempPath) => loadCatConfig(tempPath),
  });
  return validatePersistedCatalog(projectRoot);
}

function cloneCatalog(catalog: CatCafeConfig): Record<string, any> {
  return structuredClone(catalog) as Record<string, any>;
}

export function readRuntimeCatCatalog(projectRoot: string): CatCafeConfig {
  return JSON.parse(
    readPublishedRoleCatalogSource(projectRoot, resolveProjectTemplatePath(projectRoot)),
  ) as CatCafeConfig;
}

/** Account previews must not bootstrap or normalize the member owner as a read side effect. */
export function readRuntimeAccountMembers(projectRoot: string): CatCafeConfig {
  const source = readStoredCatCatalog(projectRoot);
  return source === null ? readRuntimeCatCatalog(projectRoot) : parseRawCatConfig(source.toString('utf8'));
}

/** One synchronous catalog commit for the complete confirmed selection, never a per-member PATCH loop. */
export function bindRuntimeAgyAccounts(
  projectRoot: string,
  selection: CodexBindingSelection,
  previewToken: string,
  accountProjectRoot = projectRoot,
): CatCafeConfig {
  return bindRuntimeLocalAccounts(projectRoot, selection, previewToken, accountProjectRoot, 'google');
}
export function bindRuntimeClaudeAccounts(
  projectRoot: string,
  selection: CodexBindingSelection,
  previewToken: string,
  accountProjectRoot = projectRoot,
): CatCafeConfig {
  return bindRuntimeLocalAccounts(projectRoot, selection, previewToken, accountProjectRoot, 'anthropic');
}
export function bindRuntimeCodexAccounts(
  projectRoot: string,
  selection: CodexBindingSelection,
  previewToken: string,
  accountProjectRoot = projectRoot,
): CatCafeConfig {
  return bindRuntimeLocalAccounts(projectRoot, selection, previewToken, accountProjectRoot, 'openai');
}
function bindRuntimeLocalAccounts(
  projectRoot: string,
  selection: CodexBindingSelection,
  previewToken: string,
  accountProjectRoot: string,
  client: 'openai' | 'anthropic' | 'google',
): CatCafeConfig {
  const current = readRuntimeAccountMembers(projectRoot);
  const plan =
    client === 'openai'
      ? planCodexAccountBinding(accountProjectRoot, current, selection)
      : client === 'google'
        ? planAgyAccountBinding(accountProjectRoot, current, selection)
        : planClaudeAccountBinding(accountProjectRoot, current, selection);
  if (plan.previewToken !== previewToken) throw new Error('Binding preview changed; please review it again');
  const next = planRoleAccountBinding(current, {
    ...selection,
    kind: 'bind',
    client,
    targetIds: plan.targets.map((target) => target.catId),
  });
  return writeAndValidateCatalog(projectRoot, next);
}

export function createRuntimeCat(projectRoot: string, input: RuntimeCatInput): CatCafeConfig {
  const catalog = planRoleCreation(() => readRuntimeCatCatalog(projectRoot), input);
  assertCodexMemberMutationReady(projectRoot, catalog, input.catId);
  return writeAndValidateCatalog(projectRoot, catalog);
}

export function updateRuntimeCat(projectRoot: string, catId: string, patch: RuntimeCatUpdate): CatCafeConfig {
  const { catalog, previous } = planRoleUpdate(() => readRuntimeCatCatalog(projectRoot), catId, patch);
  assertCodexMemberMutationReady(
    projectRoot,
    catalog,
    catId,
    previous,
    patch.available === true || patch.accountBindingMode !== undefined,
  );
  return writeAndValidateCatalog(projectRoot, catalog);
}

export function updateRuntimeCoCreator(projectRoot: string, patch: RuntimeCoCreatorUpdate): CatCafeConfig {
  const catalog = cloneCatalog(readRuntimeCatCatalog(projectRoot));
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

  if (patch.nickname !== undefined) {
    if (patch.nickname?.trim()) nextOwner.nickname = patch.nickname.trim();
    else delete nextOwner.nickname;
    nextOwner.nicknameSource = 'user';
  }

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
    ...(typeof nextOwner.nickname === 'string' ? { nickname: nextOwner.nickname } : {}),
    ...(nextOwner.nicknameSource === 'user' ? { nicknameSource: 'user' as const } : {}),
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
  const catalog = readRuntimeCatCatalog(projectRoot);
  const templateTombstone = findTemplateVariantTombstoneInput(projectRoot, catId);
  return writeAndValidateCatalog(projectRoot, planRoleDeletion(catalog, catId, templateTombstone));
}

export function refreshRuntimeCatCatalogCaches(): void {
  invalidateRuntimeCatalogCaches();
}
