import type { BuiltinAccountClient, CatConfig } from '@cat-cafe/shared';
import { resolveForClient } from './account-resolver.js';
import { resolveBoundAccountRefForCat, usesNativeToolConfiguration } from './cat-account-binding.js';

/** Shared by invocation and native read surfaces: an unbound native member never selects an app default. */
export function resolveCatRuntimeAccount(
  projectRoot: string,
  catId: string,
  client: BuiltinAccountClient,
  catConfig: CatConfig | null | undefined,
) {
  if (usesNativeToolConfiguration(catConfig)) return null;
  return resolveForClient(projectRoot, client, resolveBoundAccountRefForCat(projectRoot, catId, catConfig));
}
