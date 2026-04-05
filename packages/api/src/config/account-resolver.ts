/**
 * F136 Phase 4b — Unified account resolver
 *
 * Single resolution path: accounts (cat-catalog.json) + credentials (credentials.json).
 * Outputs RuntimeProviderProfile for backward-compatible consumption.
 */
import type { AccountConfig, AccountProtocol, CatProvider } from '@cat-cafe/shared';
import { readCatalogAccounts } from './catalog-accounts.js';
import { readCredential } from './credentials.js';

// ── Types surviving from provider-profiles.types.ts (F136 Phase 4d) ──

export type BuiltinAccountClient = 'anthropic' | 'openai' | 'google' | 'kimi' | 'dare' | 'opencode';
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

/** Map CatProvider to BuiltinAccountClient (null for providers without builtin accounts). */
export function resolveBuiltinClientForProvider(provider: CatProvider): BuiltinAccountClient | null {
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

const PROTOCOL_ENV_KEY_MAP: Record<AccountProtocol, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-responses': 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
};
function protocolToClient(protocol: AccountProtocol): BuiltinAccountClient {
  return protocol as BuiltinAccountClient;
}

// Known builtin OAuth account refs — both legacy names and new naming convention.
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
  if (account) return accountToRuntimeProfile(accountRef, account);

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
 * Resolve a RuntimeProviderProfile for a given built-in client/protocol.
 * If preferredAccountRef is given, tries that first.
 * Falls back to finding any account matching the protocol.
 */
export function resolveForClient(
  projectRoot: string,
  client: BuiltinAccountClient | AccountProtocol,
  preferredAccountRef?: string,
): RuntimeProviderProfile | null {
  const accounts = readCatalogAccounts(projectRoot);
  const protocol = normalizeProtocol(client);

  // Try preferred first
  if (preferredAccountRef) {
    const preferred = accounts[preferredAccountRef];
    if (preferred) return accountToRuntimeProfile(preferredAccountRef, preferred);
  }

  // Find accounts matching the protocol — return only if unambiguous (exactly one match)
  const matches: Array<[string, AccountConfig]> = [];
  for (const [ref, account] of Object.entries(accounts)) {
    if (account.protocol === protocol) {
      matches.push([ref, account]);
    }
  }
  if (matches.length === 1) {
    return accountToRuntimeProfile(matches[0][0], matches[0][1]);
  }

  if (matches.length === 0 && preferredAccountRef) {
    const builtin = BUILTIN_ACCOUNT_MAP[preferredAccountRef];
    if (builtin && builtin.protocol === protocol) {
      return {
        id: preferredAccountRef,
        authType: 'oauth',
        kind: 'builtin',
        client: builtin.client,
        protocol: builtin.protocol,
      };
    }
  }

  // 0 matches = no account configured; >1 = ambiguous → fall through to legacy
  return null;
}

function normalizeProtocol(clientOrProtocol: string): AccountProtocol {
  if (
    clientOrProtocol === 'anthropic' ||
    clientOrProtocol === 'openai' ||
    clientOrProtocol === 'openai-responses' ||
    clientOrProtocol === 'google' ||
    clientOrProtocol === 'kimi'
  ) {
    return clientOrProtocol;
  }
  // dare → openai, opencode → anthropic
  if (clientOrProtocol === 'dare') return 'openai';
  if (clientOrProtocol === 'opencode') return 'anthropic';
  return 'openai'; // safe default
}

function accountToRuntimeProfile(ref: string, account: AccountConfig): RuntimeProviderProfile {
  const credential = readCredential(ref);
  const apiKey = credential?.apiKey;

  const isBuiltin = account.authType === 'oauth';
  return {
    id: ref,
    authType: account.authType,
    kind: isBuiltin ? 'builtin' : 'api_key',
    ...(isBuiltin ? { client: protocolToClient(account.protocol) } : {}),
    protocol: account.protocol,
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(account.models && account.models.length > 0 ? { models: [...account.models] } : {}),
  };
}

// ── Validation helpers (moved from provider-binding-compat.ts, F136 Phase 4d) ──

/**
 * Map a cat client/provider to the protocol it requires.
 * Returns null for clients that accept any protocol (opencode).
 */
function expectedProtocolForProvider(provider: CatProvider): AccountProtocol | null {
  switch (provider) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    case 'kimi':
      return 'kimi';
    case 'dare':
      return 'openai';
    case 'opencode':
      return null; // opencode supports any protocol
    default:
      return null;
  }
}
export function validateRuntimeProviderBinding(
  provider: CatProvider,
  profile: RuntimeProviderProfile,
  _defaultModel?: string | null,
): string | null {
  if (provider === 'google' && profile.kind !== 'builtin') {
    return 'client "google" only supports builtin Gemini auth';
  }
  const expectedClient = resolveBuiltinClientForProvider(provider);
  if (expectedClient && profile.kind === 'builtin' && profile.client && profile.client !== expectedClient) {
    return `bound provider profile "${profile.id}" is incompatible with client "${provider}"`;
  }
  // Protocol matching removed: protocol is now provider-determined, not an
  // account-level attribute. Runtime env injection uses provider directly.
  return null;
}

export function validateModelFormatForProvider(
  provider: CatProvider,
  defaultModel?: string | null,
  profileKind?: ProviderProfileKind,
  ocProviderName?: string | null,
  options?: { legacyCompat?: boolean; accountModels?: string[] },
): string | null {
  if (provider !== 'opencode') return null;
  if (profileKind === 'api_key') {
    const trimmedOcProvider = ocProviderName?.trim();
    // F189 intake: provider/model in defaultModel is the primary path.
    // ocProviderName is only required when defaultModel is a bare model name.
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
    //     if "x/y" is in the list but bare "y" is not → ambiguous namespace → require ocProviderName.
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
    if (!trimmedOcProvider && !modelHasProvider) {
      if (options?.legacyCompat) return null;
      return 'client "opencode" with API key auth requires either a provider/model format (e.g. minimax/MiniMax-M2.7) or an explicit Provider name';
    }
    if (trimmedOcProvider?.includes('/')) {
      return 'OpenCode Provider name must not contain "/" — use a plain identifier (e.g. "openrouter", not "openrouter/google")';
    }
  }
  return null;
}
