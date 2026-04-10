/**
 * F136 Phase 4b — Unified account resolver
 *
 * Single resolution path: accounts (cat-catalog.json) + credentials (credentials.json).
 * Outputs RuntimeProviderProfile for backward-compatible consumption.
 */
import type { AccountConfig, AccountProtocol, ClientId } from '@cat-cafe/shared';
import { readCatalogAccounts } from './catalog-accounts.js';
import { readCredential } from './credentials.js';

// ── Types surviving from provider-profiles.types.ts (F136 Phase 4d) ──

export type BuiltinAccountClient = Extract<ClientId, 'anthropic' | 'openai' | 'google' | 'kimi' | 'dare' | 'opencode'>;
export type ProviderProfileKind = 'builtin' | 'api_key';

export interface RuntimeProviderProfile {
  id: string;
  authType: 'oauth' | 'api_key';
  kind: ProviderProfileKind;
  client?: BuiltinAccountClient;
  protocol?: AccountProtocol;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
}

export interface AnthropicRuntimeProfile {
  id: string;
  mode: 'subscription' | 'api_key';
  baseUrl?: string;
  apiKey?: string;
}

/** Map ClientId to BuiltinAccountClient (null for clients without builtin accounts). */
export function resolveBuiltinClientForProvider(provider: ClientId): BuiltinAccountClient | null {
  switch (provider) {
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'kimi':
    case 'dare':
    case 'opencode':
      return provider;
    default:
      return null;
  }
}

// Legacy builtin account IDs — must match the IDs originally defined in provider-profiles.ts
// BUILTIN_ACCOUNT_SPECS so that existing catalogs, seeds, and migration logic continue to work.
const LEGACY_BUILTIN_IDS: Record<BuiltinAccountClient, string> = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  kimi: 'kimi',
  dare: 'dare',
  opencode: 'opencode',
};

export function builtinAccountIdForClient(client: BuiltinAccountClient): string {
  return LEGACY_BUILTIN_IDS[client];
}

export function resolveAnthropicRuntimeProfile(projectRoot: string): AnthropicRuntimeProfile {
  // F340: Use full discovery chain (claude → builtin_anthropic → installer-anthropic).
  const runtime = resolveForClient(projectRoot, 'anthropic');
  if (runtime?.apiKey) {
    return {
      id: runtime.id,
      mode: runtime.authType === 'oauth' ? 'subscription' : 'api_key',
      ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
      apiKey: runtime.apiKey,
    };
  }
  return { id: 'builtin_anthropic', mode: 'subscription' };
}

// Known builtin OAuth account refs — both legacy names and new naming convention.
// F340: protocol is derived from client identity, no longer stored on accounts.
const BUILTIN_ACCOUNT_MAP: Record<string, { client: BuiltinAccountClient; protocol: AccountProtocol }> = {
  claude: { client: 'anthropic', protocol: 'anthropic' },
  builtin_anthropic: { client: 'anthropic', protocol: 'anthropic' },
  codex: { client: 'openai', protocol: 'openai' },
  builtin_openai: { client: 'openai', protocol: 'openai' },
  gemini: { client: 'google', protocol: 'google' },
  builtin_google: { client: 'google', protocol: 'google' },
  kimi: { client: 'kimi', protocol: 'kimi' },
  builtin_kimi: { client: 'kimi', protocol: 'kimi' },
  dare: { client: 'dare', protocol: 'openai' },
  builtin_dare: { client: 'dare', protocol: 'openai' },
  opencode: { client: 'opencode', protocol: 'anthropic' },
  builtin_opencode: { client: 'opencode', protocol: 'anthropic' },
};

/**
 * Resolve a single accountRef to RuntimeProviderProfile.
 * Falls back to a synthetic builtin profile for known OAuth refs
 * that haven't been migrated to the catalog yet (fresh installs).
 */
export function resolveByAccountRef(projectRoot: string, accountRef: string): RuntimeProviderProfile | null {
  const accounts = readCatalogAccounts(projectRoot);
  const account = accounts[accountRef];
  if (account) return accountToRuntimeProfile(accountRef, account, projectRoot);

  // Synthetic builtin profile for known OAuth refs
  const builtin = BUILTIN_ACCOUNT_MAP[accountRef];
  if (builtin) {
    return {
      id: accountRef,
      authType: 'oauth',
      kind: 'builtin',
      client: builtin.client,
      protocol: builtin.protocol,
    };
  }
  return null;
}

/**
 * Resolve a RuntimeProviderProfile for a given built-in client.
 * If preferredAccountRef is given, tries that first.
 * Falls back to the well-known builtin account ID for the client.
 *
 * F340: No longer matches by account.protocol — protocol is derived from
 * client identity at runtime, not stored on accounts.
 */
export function resolveForClient(
  projectRoot: string,
  client: BuiltinAccountClient | AccountProtocol,
  preferredAccountRef?: string,
): RuntimeProviderProfile | null {
  const accounts = readCatalogAccounts(projectRoot);

  // Try preferred first — fail closed if explicit ref doesn't resolve.
  if (preferredAccountRef) {
    const preferred = accounts[preferredAccountRef];
    if (preferred) return accountToRuntimeProfile(preferredAccountRef, preferred, projectRoot);
    // Not in accounts — only allow synthetic builtin (fresh install with empty accounts).
    const builtin = BUILTIN_ACCOUNT_MAP[preferredAccountRef];
    if (builtin) {
      return {
        id: preferredAccountRef,
        authType: 'oauth',
        kind: 'builtin',
        client: builtin.client,
        protocol: builtin.protocol,
      };
    }
    return null;
  }

  // F340: Walk the full discovery chain; prefer accounts with credentials.
  // This ensures installer-${client} (which holds API keys) is chosen over
  // an OAuth builtin that has no stored credential.
  const normalizedClient = normalizeToClient(client);
  if (normalizedClient) {
    const wellKnownId = LEGACY_BUILTIN_IDS[normalizedClient];
    const candidateIds = [wellKnownId, `builtin_${normalizedClient}`, `installer-${normalizedClient}`];
    let firstMatch: RuntimeProviderProfile | null = null;
    for (const id of candidateIds) {
      if (accounts[id]) {
        const profile = accountToRuntimeProfile(id, accounts[id], projectRoot);
        if (profile.authType === 'api_key' && profile.apiKey) return profile;
        firstMatch ??= profile;
      }
    }
    if (firstMatch) return firstMatch;
  }

  // Synthetic builtin fallback: only when no real accounts matched at all
  // (fresh install, test env with empty accounts)
  if (normalizedClient) {
    const wellKnownRef = LEGACY_BUILTIN_IDS[normalizedClient];
    const builtin = wellKnownRef ? BUILTIN_ACCOUNT_MAP[wellKnownRef] : undefined;
    if (builtin) {
      return {
        id: wellKnownRef,
        authType: 'oauth',
        kind: 'builtin',
        client: builtin.client,
        protocol: builtin.protocol,
      };
    }
  }

  return null;
}

/** Map a client ID or protocol string to its BuiltinAccountClient equivalent. */
function normalizeToClient(clientOrProtocol: string): BuiltinAccountClient | null {
  switch (clientOrProtocol) {
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'kimi':
    case 'dare':
    case 'opencode':
      return clientOrProtocol;
    case 'openai-responses':
      return 'openai';
    default:
      return null;
  }
}

function accountToRuntimeProfile(ref: string, account: AccountConfig, projectRoot?: string): RuntimeProviderProfile {
  const credential = readCredential(ref, projectRoot);
  const apiKey = credential?.apiKey;

  const isBuiltin = account.authType === 'oauth';
  // F340: Derive client and protocol solely from well-known account ID map.
  // account.protocol is retired — not read, not written.
  const builtinInfo = BUILTIN_ACCOUNT_MAP[ref];
  return {
    id: ref,
    authType: account.authType,
    kind: isBuiltin ? 'builtin' : 'api_key',
    ...(isBuiltin && builtinInfo ? { client: builtinInfo.client } : {}),
    ...(builtinInfo?.protocol ? { protocol: builtinInfo.protocol } : {}),
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(account.models && account.models.length > 0 ? { models: [...account.models] } : {}),
  };
}

// ── Validation helpers (moved from provider-binding-compat.ts, F136 Phase 4d) ──

export function validateRuntimeProviderBinding(
  clientId: ClientId,
  profile: RuntimeProviderProfile,
  _defaultModel?: string | null,
): string | null {
  if (clientId === 'google' && profile.kind !== 'builtin') {
    return 'client "google" only supports builtin Gemini auth';
  }
  const expectedClient = resolveBuiltinClientForProvider(clientId);
  if (expectedClient && profile.kind === 'builtin' && profile.client && profile.client !== expectedClient) {
    return `bound provider profile "${profile.id}" is incompatible with client "${clientId}"`;
  }
  // Protocol matching removed: protocol is now provider-determined, not an
  // account-level attribute. Runtime env injection uses provider directly.
  return null;
}

export function validateModelFormatForProvider(
  clientId: ClientId,
  defaultModel?: string | null,
  profileKind?: ProviderProfileKind,
  providerName?: string | null,
  options?: { legacyCompat?: boolean; accountModels?: string[] },
): string | null {
  if (clientId !== 'opencode') return null;
  if (profileKind === 'api_key') {
    const trimmedProvider = providerName?.trim();
    // F189 intake: provider/model in defaultModel is the primary path.
    // provider name is only required when defaultModel is a bare model name.
    // Must match parseOpenCodeModel logic: slash must have content on both sides
    // (rejects trailing slash like "minimax/" and leading slash like "/model").
    const modelTrimmed = defaultModel?.trim() ?? '';
    const slashIdx = modelTrimmed.indexOf('/');
    const looksLikeProviderModel = slashIdx > 0 && slashIdx < modelTrimmed.length - 1;
    // Distinguish canonical provider/model from namespaced model (e.g. openrouter's z-ai/glm-4.7).
    // Two-layer check:
    //   Layer 1 — Known provider prefix: if the prefix before "/" is a known opencode provider
    //     (anthropic, openai, openrouter, google), it's canonical regardless of account model list.
    //     Synced with BUILTIN_OPENCODE_PROVIDERS in invoke-single-cat.ts.
    //   Layer 2 — Account model list fallback (for non-builtin providers like minimax):
    //     if "x/y" is in the list AND bare "y" is also in the list → canonical (dual-form).
    //     if "x/y" is in the list but bare "y" is not → ambiguous namespace → require provider name.
    //     if "x/y" is NOT in the list → user-provided canonical form → accept.
    const KNOWN_CANONICAL_PROVIDERS = new Set(['anthropic', 'openai', 'openrouter', 'google']);
    const bareModel = looksLikeProviderModel ? modelTrimmed.slice(slashIdx + 1) : '';
    const parsedPrefix = looksLikeProviderModel ? modelTrimmed.slice(0, slashIdx) : '';
    const models = options?.accountModels;
    const isNamespacedModel =
      looksLikeProviderModel &&
      !KNOWN_CANONICAL_PROVIDERS.has(parsedPrefix) &&
      models?.some((m) => m === modelTrimmed) === true &&
      models?.some((m) => m === bareModel) !== true;
    const modelHasProvider = looksLikeProviderModel && !isNamespacedModel;
    if (!trimmedProvider && !modelHasProvider) {
      if (options?.legacyCompat) return null;
      return 'client "opencode" with API key auth requires either a provider/model format (e.g. minimax/MiniMax-M2.7) or an explicit Provider name';
    }
    if (trimmedProvider?.includes('/')) {
      return 'OpenCode Provider name must not contain "/" — use a plain identifier (e.g. "openrouter", not "openrouter/google")';
    }
  }
  return null;
}
