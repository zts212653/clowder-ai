import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CatConfig } from '@cat-cafe/shared';
import { builtinAccountIdForClient, resolveBuiltinClientForProvider } from './account-resolver.js';
import { loadCatConfig, toAllCatConfigs } from './cat-config-loader.js';
import { resolveProjectTemplatePath } from './project-template-path.js';

function trimBinding(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isSeedCat(projectRoot: string, catId: string): boolean {
  try {
    const seedCats = toAllCatConfigs(loadCatConfig(resolveProjectTemplatePath(projectRoot)));
    return Object.hasOwn(seedCats, catId);
  } catch {
    return false;
  }
}

export function resolveBoundAccountRefForCat(
  projectRoot: string,
  catId: string,
  catConfig: CatConfig | null | undefined,
): string | undefined {
  if (!catConfig) return undefined;

  const explicitAccountRef = trimBinding(catConfig.accountRef);
  if (!explicitAccountRef) return undefined;

  const builtinClient = resolveBuiltinClientForProvider(catConfig.clientId);
  const isDefaultBinding = !!builtinClient && explicitAccountRef === builtinAccountIdForClient(builtinClient);
  // F340: only suppress default accountRef for seed cats (template-originated), not custom ones
  const isSeed = isSeedCat(projectRoot, catId);
  if (isSeed && isDefaultBinding) {
    return undefined;
  }

  return explicitAccountRef;
}
