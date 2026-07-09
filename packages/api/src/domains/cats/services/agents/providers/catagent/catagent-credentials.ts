/**
 * CatAgent Credentials — F159: Native Provider Security Baseline
 *
 * Resolves API credentials for direct API calls using the account-binding
 * fail-closed pattern from invoke-single-cat. G1 (AC-G5): `clientFamily`
 * is parameterised so adapters that don't speak Anthropic (G2 OpenAI Chat;
 * G3 Gemini) can resolve their own account profile family.
 *
 * Single source of truth: catConfig.accountRef → resolveForClient(clientFamily).
 * No env override, no fallback scan — fail closed if binding is missing.
 */

import type { CatConfig } from '@cat-cafe/shared';
import { resolveForClient } from '../../../../../../config/account-resolver.js';
// `BuiltinAccountClient` is the resolver's narrow union (subset of ClientId).
// Imported as a type-only re-export from account-resolver to avoid importing
// from @cat-cafe/shared twice in this file.
import type { BuiltinAccountClient } from '../../../../../../config/account-resolver.js';
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
 *
 * `clientFamily` defaults to `'anthropic'` for backward compatibility with
 * pre-G1 call sites; new G1+ callers (`CatAgentService` via adapter)
 * pass `adapter.clientFamily` explicitly to keep the adapter as the single
 * source of truth for protocol identity.
 */
export function resolveApiCredentials(
  projectRoot: string,
  catId: string,
  catConfig: CatConfig | null | undefined,
  clientFamily: string = 'anthropic',
): ApiCredentials | null {
  const boundRef = resolveBoundAccountRefForCat(projectRoot, catId, catConfig);
  if (!boundRef) {
    log.warn(`[${catId}] No bound accountRef in catConfig — cannot resolve credentials`);
    return null;
  }

  // G1: adapter declares clientFamily as `string` to leave room for future
  // protocols (G2 OpenAI Chat / G3 Gemini); resolveForClient currently
  // accepts a narrow `BuiltinAccountClient | AccountProtocol` union. Cast
  // at this boundary — if a future adapter ships a clientFamily not in
  // that union, resolveForClient will return null and credentials resolution
  // will fail closed (existing behaviour for unknown profiles, AC-B1).
  const profile = resolveForClient(projectRoot, clientFamily as BuiltinAccountClient, boundRef);
  if (!profile?.apiKey) {
    log.warn(`[${catId}] Bound account "${boundRef}" did not resolve to an API key (family=${clientFamily})`);
    return null;
  }

  // G1 P2 fix (@gpt555 implementation review on PR #23): `clientFamily`
  // must actually guard the resolved profile, not just be passed through.
  // resolveForClient's `preferredAccountRef` branch (account-resolver.ts:161-162)
  // returns the account by ref without verifying its family — so an OAuth
  // Anthropic builtin (e.g. `claude`) could resolve under
  // `clientFamily='openai'` silently, making AC-G5 cosmetic and exposing
  // G2 to silent family routing failures when OpenAIChatAdapter lands.
  //
  // Post-check: if the profile carries a builtin client identity
  // (`profile.client` is set only for OAuth/builtin accounts per
  // `accountToRuntimeProfile`), it MUST match the requested clientFamily.
  // Mismatch → fail closed.
  //
  // Scope note (deferred to G2 spec): api_key accounts today have no
  // explicit family on schema (`accountToRuntimeProfile` only sets
  // `profile.client` for OAuth builtins). The G2 spec must define how
  // api_key accounts declare family so this guard becomes complete
  // (not just OAuth/builtin half). For now api_key + missing family is
  // best-effort and falls through — the runtime API call will fail if
  // the proxy doesn't speak the requested protocol, surfacing the
  // mismatch at first invocation rather than silently routing.
  if (profile.client !== undefined && profile.client !== clientFamily) {
    log.warn(
      `[${catId}] Bound account "${boundRef}" client=${profile.client} mismatch with adapter clientFamily=${clientFamily} — fail closed`,
    );
    return null;
  }

  log.info(`[${catId}] Resolved API key from bound account: ${boundRef} (family=${clientFamily})`);
  return { apiKey: profile.apiKey, baseURL: profile.baseUrl, source: `bound:${boundRef}` };
}
