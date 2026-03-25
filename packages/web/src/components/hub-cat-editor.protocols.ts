import type { ClientValue } from './hub-cat-editor.model';

export function protocolForClient(client: ClientValue): 'anthropic' | 'openai' | 'google' | null {
  switch (client) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
    case 'relayclaw':
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

export function defaultMcpSupportForClient(client: ClientValue): boolean {
  return client === 'anthropic' || client === 'openai' || client === 'google' || client === 'opencode';
}
