import type { IncomingMessage } from 'node:http';
import { z } from 'zod';

const MODERN_VERSION = '2026-07-28';
const serverInfo = { name: 'cat-cafe-cloud-pro-b1a', version: '0.0.5-b1a' };

/** Adapt the modern client header to the pinned SDK after handling its discovery handshake. */
export function adaptModernToolHeaders(req: IncomingMessage): boolean {
  if (req.headers['mcp-protocol-version'] !== MODERN_VERSION) return false;
  req.headers['mcp-protocol-version'] = '2025-11-25';
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]?.toLowerCase();
    if (name === 'mcp-protocol-version') req.rawHeaders[index + 1] = '2025-11-25';
    if (name === 'accept' && req.rawHeaders[index + 1]?.includes('application/json'))
      req.rawHeaders[index + 1] = 'application/json, text/event-stream';
  }
  return true;
}

const initialization = z
  .object({
    protocolVersion: z.literal(MODERN_VERSION),
    capabilities: z.record(z.unknown()),
    clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough(),
  })
  .passthrough();

const request = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().max(128), z.number(), z.null()]),
    method: z.string().max(100),
    params: z.unknown().optional(),
  })
  .strict();

/** Generic protocol discovery only. Installed-plugin methods are never added to the Pro server. */
export function modernProtocolRpc(
  body: unknown,
  options: { readonly events?: boolean } = {},
): { status: number; body: unknown } | null {
  const parsed = request.safeParse(body);
  if (!parsed.success) return null;
  const rpc = parsed.data;
  if (rpc.method === 'server/discover') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          resultType: 'complete',
          supportedVersions: [MODERN_VERSION, '2025-11-25'],
          capabilities: { tools: {}, ...(options.events ? { events: {} } : {}) },
        },
      },
    };
  }
  if (
    rpc.method === 'initialize' &&
    rpc.params &&
    typeof rpc.params === 'object' &&
    'protocolVersion' in rpc.params &&
    rpc.params.protocolVersion === MODERN_VERSION
  ) {
    if (!initialization.safeParse(rpc.params).success) {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32602, message: 'Invalid initialization parameters' },
        },
      };
    }
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          protocolVersion: MODERN_VERSION,
          capabilities: { tools: {}, ...(options.events ? { events: {} } : {}) },
          serverInfo,
        },
      },
    };
  }
  return null;
}
