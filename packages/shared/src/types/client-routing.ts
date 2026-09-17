import type { ClientId } from './cat.js';
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

/** Canonical family, CLI name and historical builtin_* aliases are one identity table. */
export const BUILTIN_ACCOUNT_CLIENT_FOR_ID: Readonly<Record<string, BuiltinAccountClient>> = Object.freeze(
  Object.fromEntries(
    Object.entries(BUILTIN_ACCOUNT_IDS).flatMap(([family, cliName]) =>
      [...new Set([cliName, family, `builtin_${family}`])].map((ref) => [ref, family as BuiltinAccountClient]),
    ),
  ),
);

export function builtinAccountFamilyForRef(ref: string): BuiltinAccountClient | null {
  return Object.hasOwn(BUILTIN_ACCOUNT_CLIENT_FOR_ID, ref) ? (BUILTIN_ACCOUNT_CLIENT_FOR_ID[ref] ?? null) : null;
}

/** Older installers omitted clientId; these API-key refs are not synthetic OAuth accounts. */
export function legacyAccountFamilyForRef(ref: string): BuiltinAccountClient | null {
  return (
    builtinAccountFamilyForRef(ref) ??
    (Object.keys(BUILTIN_ACCOUNT_IDS) as BuiltinAccountClient[]).find((family) => ref === `installer-${family}`) ??
    null
  );
}

export function builtinAccountFamilyForClient(client: ClientId): BuiltinAccountClient | null {
  if (client === 'catagent') return 'anthropic';
  // Generic ACP has no family, so it must never get a synthetic builtin account.
  return Object.hasOwn(BUILTIN_ACCOUNT_IDS, client) ? (client as BuiltinAccountClient) : null;
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
