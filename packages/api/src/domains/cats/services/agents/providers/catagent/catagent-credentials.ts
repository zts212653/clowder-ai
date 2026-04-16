/**
 * CatAgent Credentials — F159: Native Provider Security Baseline
 *
 * Resolves Anthropic API key for direct API calls using the
 * account-binding fail-closed pattern from invoke-single-cat.
 *
 * Single source of truth: catConfig.accountRef → resolveForClient.
 * No env override, no fallback scan — fail closed if binding is missing.
 */

import type { CatConfig } from '@cat-cafe/shared';
import { resolveForClient } from '../../../../../../config/account-resolver.js';
import { resolveBoundAccountRefForCat } from '../../../../../../config/cat-account-binding.js';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';

const log = createModuleLogger('catagent-creds');

export interface ApiCredentials {
  apiKey: string;
  baseURL?: string;
  source: string;
}

/**
 * Resolve API credentials using account-binding (fail-closed).
 *
 * Single resolution path: catConfig.accountRef → resolveBoundAccountRefForCat → resolveForClient.
 * No env override — account binding is the sole source of truth (AC-B1).
 * No wildcard credential scan — if the bound account doesn't resolve, returns null.
 */
export function resolveApiCredentials(
  projectRoot: string,
  catId: string,
  catConfig: CatConfig | null | undefined,
): ApiCredentials | null {
  const boundRef = resolveBoundAccountRefForCat(projectRoot, catId, catConfig);
  if (!boundRef) {
    log.warn(`[${catId}] No bound accountRef in catConfig — cannot resolve credentials`);
    return null;
  }

  const profile = resolveForClient(projectRoot, 'anthropic', boundRef);
  if (!profile?.apiKey) {
    log.warn(`[${catId}] Bound account "${boundRef}" did not resolve to an API key`);
    return null;
  }

  log.info(`[${catId}] Resolved API key from bound account: ${boundRef}`);
  return { apiKey: profile.apiKey, baseURL: profile.baseUrl, source: `bound:${boundRef}` };
}
