import type { AcpInitializeParams } from './types.js';

/** ACP transport implementation revision, not the member/provider/account identity. */
export function buildAcpInitializeParams() {
  return {
    protocolVersion: 1,
    clientInfo: { name: 'clowder-ai', title: 'Clowder AI', version: '1' },
    // Both transports currently reject fs/terminal requests with method-not-found.
    // Elicitation/session extensions remain unadvertised until their handlers exist.
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  } satisfies AcpInitializeParams;
}
