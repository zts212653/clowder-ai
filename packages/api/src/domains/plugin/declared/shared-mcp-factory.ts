import type { GatewayMcpServer } from '@cat-cafe/mcp-server/dist/member-gateway.js';

/** Package ABI: the Host supplies a closure, never credentials or ambient environment. */
export interface SharedMcpActionClient {
  invoke(
    method: string,
    input: unknown,
    call?: { readonly signal?: AbortSignal; readonly _meta?: unknown },
  ): Promise<unknown>;
}

export type SharedMcpFactory = (client: SharedMcpActionClient) => GatewayMcpServer;
