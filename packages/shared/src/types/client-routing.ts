import type { CatConfig, ClientId } from './cat.js';
import type { AccountProtocol } from './cat-breed.js';

export type BuiltinAccountClient = Extract<ClientId, 'anthropic' | 'openai' | 'google' | 'kimi' | 'opencode'>;
export type BuiltinAccountProtocol = Extract<AccountProtocol, 'anthropic' | 'openai' | 'google' | 'kimi'>;

const BUILTIN_ACCOUNT_IDS: Record<BuiltinAccountClient, string> = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  kimi: 'kimi',
  opencode: 'opencode',
};

export function builtinAccountFamilyForClient(client: ClientId): BuiltinAccountClient | null {
  switch (client) {
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'kimi':
    case 'opencode':
      return client;
    // F161: generic ACP is a transport, not an account family — no synthetic builtin account.
    // Returning null prevents auto-rebase from rewriting accountRef to non-existent 'acp'.
    case 'catagent':
      return 'anthropic';
    default:
      return null;
  }
}

export function builtinAccountIdForClient(client: ClientId): string | null {
  const family = builtinAccountFamilyForClient(client);
  return family ? BUILTIN_ACCOUNT_IDS[family] : null;
}

export function protocolForClient(client: ClientId): BuiltinAccountProtocol | null {
  switch (client) {
    case 'anthropic':
    case 'catagent':
    case 'opencode':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    case 'kimi':
      return 'kimi';
    default:
      return null;
  }
}

// ── F159 Phase G G2 Axis 3 (KD-24): member-level protocol-aware helpers ──
//
// `protocolForClient` / `builtinAccountFamilyForClient` above are kept as
// pure `clientId → default family/protocol` mappings (client-level default),
// matching the @gpt555 G2 design gate P2 decision: changing those to accept
// `catConfig` would pollute shared routing semantics and force every
// downstream call site to thread `catConfig` through. The G2 effective*
// helpers below take per-member catConfig and surface the protocol-aware
// answer when `clientId === 'catagent'` (where `catAgentProtocol` overrides
// the client-level default), falling through to the client-level helpers
// otherwise.
//
// ── AC-G19 Migration Audit (completed 2026-06-24 per @gpt555 G2 Axis 3 P2) ──
//
// Audit of every existing `protocolForClient('catagent')` /
// `builtinAccountFamilyForClient('catagent')` call site with per-site decision:
//
// | Call site                                         | Decision  | Rationale                                                                                                                                                |
// | ------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
// | account-resolver.ts:45  resolveBuiltinClientForProvider(provider: ClientId) | KEEP   | Helper accepts only ClientId; caller has no catConfig context. Catagent-aware credential resolution flows through `catagent-credentials.ts` w/ `adapter.clientFamily` (Axis 2 already wires this end-to-end). |
// | account-resolver.ts:131 builtinProtocol from BUILTIN_ACCOUNT_MAP ref           | KEEP   | Profile-shape derivation from synthetic builtin ref (OAuth fallback); catAgentProtocol does not apply at the account-profile layer.                                                              |
// | account-resolver.ts:165 same as :131 in preferred-ref branch                   | KEEP   | Same — synthetic builtin profile shape; not member-level.                                                                                                                                       |
// | account-resolver.ts:202 same as :131 in walk-discovery-chain branch           | KEEP   | Same.                                                                                                                                                                                            |
// | account-resolver.ts:241 same as :131 in synthetic-fallback branch             | KEEP   | Same.                                                                                                                                                                                            |
// | first-run-quest.ts:437  buildProbeEnv(clientId, ...)                          | KEEP   | First-run credential probe runs BEFORE any cat is persisted — there is no CatConfig at this point, only the operator's chosen clientId for probing. Catagent-specific protocol is decided post-creation.       |
// | hub-cat-editor.model.ts:381 resolveBuiltinClientFamily → filterAccounts       | DEFERRED | Hub UI account-picker filter; for catagent + 'openai-chat' the picker should arguably show OpenAI accounts. Migration requires threading `form.catAgentProtocol` through `filterAccounts`. Tracked as Axis 6 cross-cutting UX polish — does NOT block G2 merge gate (credentials path still fails-closed at adapter level via Axis 2). |
//
// Outcome: 6 sites KEEP client-level default (correct semantics — they
// operate on ClientId / profile shape, not member-level routing). 1 site
// DEFERRED with explicit follow-up tracker. Zero sites required immediate
// migration to satisfy AC-G19; the client-level / member-level split is
// honored everywhere a catConfig is actually in scope.

/**
 * Resolve the effective wire protocol for a CatAgent member, honoring the
 * `catAgentProtocol` selection bit persisted on `CatConfig`.
 *
 * - non-catagent clients → falls through to `protocolForClient(clientId)`
 *   so existing behavior is unchanged
 * - catagent + `catAgentProtocol === 'openai-chat'` → `'openai'`
 * - catagent + `catAgentProtocol === 'anthropic-messages'` → `'anthropic'`
 * - catagent + undefined / unknown → `'anthropic'` (G1 catagent backward-
 *   compat default; matches `catagent-protocol-factory.ts` default branch)
 *
 * Returns `null` only when the underlying client has no protocol mapping
 * (e.g. 'antigravity' / 'acp').
 */
export function effectiveProtocolForCat(catConfig: CatConfig): BuiltinAccountProtocol | null {
  if (catConfig.clientId === 'catagent') {
    if (catConfig.catAgentProtocol === 'openai-chat') return 'openai';
    // 'anthropic-messages' or undefined / unrecognised → anthropic default.
    // (Factory still fail-closes on unknown values at adapter dispatch
    // time — this helper is for routing/account-binding decisions where
    // a sensible default is more useful than throwing.)
    return 'anthropic';
  }
  return protocolForClient(catConfig.clientId);
}

/**
 * Resolve the effective builtin account family for a CatAgent member,
 * honoring the `catAgentProtocol` selection bit on `CatConfig`.
 *
 * - non-catagent clients → falls through to `builtinAccountFamilyForClient(clientId)`
 * - catagent + `'openai-chat'` → `'openai'`
 * - catagent + `'anthropic-messages'` / undefined → `'anthropic'` (G1
 *   backward-compat default)
 */
export function effectiveClientFamilyForCat(catConfig: CatConfig): BuiltinAccountClient | null {
  if (catConfig.clientId === 'catagent') {
    if (catConfig.catAgentProtocol === 'openai-chat') return 'openai';
    return 'anthropic';
  }
  return builtinAccountFamilyForClient(catConfig.clientId);
}
