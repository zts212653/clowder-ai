import type { ClientId } from './cat.js';

/**
 * Member access mode. This is deliberately separate from wire transports such
 * as MCP stdio/HTTP and ACP stdio/httpstream.
 */
export const CAT_CARRIERS = ['cli', 'sdk', 'app_server', 'acp'] as const;
export type CatCarrier = (typeof CAT_CARRIERS)[number];

const CARRIERS_BY_CLIENT: Readonly<Record<string, readonly CatCarrier[]>> = Object.freeze({
  anthropic: ['cli', 'sdk'],
  openai: ['cli', 'app_server'],
  google: ['cli', 'acp'],
  kimi: ['cli', 'acp'],
  opencode: ['cli', 'acp'],
  acp: ['acp'],
  antigravity: ['cli'],
  catagent: ['cli'],
  a2a: ['cli'],
});

export function getCatCarrierOptions(clientId: ClientId | string): readonly CatCarrier[] {
  return CARRIERS_BY_CLIENT[clientId] ?? ['cli'];
}

export function catClientSupportsCarrier(clientId: ClientId | string, carrier: CatCarrier): boolean {
  return getCatCarrierOptions(clientId).includes(carrier);
}
