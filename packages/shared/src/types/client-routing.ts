import type { ClientId } from './cat.js';
import type { AccountProtocol } from './cat-breed.js';

export type BuiltinAccountClient = Extract<ClientId, 'anthropic' | 'openai' | 'google' | 'kimi' | 'dare' | 'opencode'>;
export type BuiltinAccountProtocol = Extract<AccountProtocol, 'anthropic' | 'openai' | 'google' | 'kimi'>;

const BUILTIN_ACCOUNT_IDS: Record<BuiltinAccountClient, string> = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  kimi: 'kimi',
  dare: 'dare',
  opencode: 'opencode',
};

export function builtinAccountFamilyForClient(client: ClientId): BuiltinAccountClient | null {
  switch (client) {
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'kimi':
    case 'dare':
    case 'opencode':
      return client;
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
    case 'dare':
      return 'openai';
    case 'google':
      return 'google';
    case 'kimi':
      return 'kimi';
    default:
      return null;
  }
}
