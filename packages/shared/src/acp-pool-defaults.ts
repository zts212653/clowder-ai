import type { ClientId } from './types/cat.js';

/** ACP process limits only; CLI and native carriers keep their own policies. */
export function defaultAcpPoolMaxProcesses(clientId: ClientId) {
  return clientId === 'google' ? 3 : 20;
}
