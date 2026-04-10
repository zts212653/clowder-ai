import type { ClientId } from './hub-cat-editor.model';

export function protocolForClient(client: ClientId): 'anthropic' | 'openai' | 'google' | null {
  switch (client) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    case 'dare':
      return 'openai';
    case 'opencode':
      return 'anthropic';
    default:
      return null;
  }
}

export function defaultMcpSupportForClient(client: ClientId): boolean {
  return client === 'anthropic' || client === 'openai' || client === 'google' || client === 'opencode';
}
