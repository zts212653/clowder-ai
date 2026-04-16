import { protocolForClient as sharedProtocolForClient } from '@cat-cafe/shared';
import type { ClientId } from './hub-cat-editor.model';

export function protocolForClient(client: ClientId): 'anthropic' | 'openai' | 'google' | 'kimi' | null {
  return sharedProtocolForClient(client);
}

export function defaultMcpSupportForClient(client: ClientId): boolean {
  return (
    client === 'anthropic' || client === 'openai' || client === 'google' || client === 'kimi' || client === 'opencode'
  );
}
