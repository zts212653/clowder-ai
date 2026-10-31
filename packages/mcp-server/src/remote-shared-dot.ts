import type { IncomingMessage } from 'node:http';
import { DOT_TOOLS, dotAskArguments, dotEventRefSchema, dotImageArguments, dotReplyArguments } from '@cat-cafe/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { registerCoCreatorPresentation } from './co-creator-presentation.js';
import { getCallbackConfig } from './tools/callback-tools.js';

const RPC_METHODS = new Set(['events/list', 'events/subscribe', 'events/unsubscribe']);
const MODERN_VERSION = '2026-07-28';
const serverInfo = { name: 'cat-cafe-cloud-pro-b1a', version: '0.0.5-b1a' };

/** Adapt MCP 2.0 tool calls to the pinned SDK's wire shape after outer auth.
 * Hono reads rawHeaders. Only protocol/Accept change; credentials stay bound. */
export function adaptModernToolHeaders(req: IncomingMessage): boolean {
  if (req.headers['mcp-protocol-version'] !== MODERN_VERSION) return false;
  req.headers['mcp-protocol-version'] = '2025-11-25';
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]?.toLowerCase();
    if (name === 'mcp-protocol-version') req.rawHeaders[index + 1] = '2025-11-25';
    // The SDK checks JSON + SSE; its enableJsonResponse keeps the response JSON.
    if (name === 'accept' && req.rawHeaders[index + 1]?.includes('application/json'))
      req.rawHeaders[index + 1] = 'application/json, text/event-stream';
  }
  return true;
}

/** The outer installed connection is authenticated by remote-spike. Caller
 * headers/selectors are never forwarded; Host verifies the service-bound Pro
 * principal and resolves its installed dot. A shared token is not a dot identity. */
async function callDotHost(body: unknown): Promise<Response> {
  const config = getCallbackConfig({ forceAgentKey: true });
  if (!config?.agentKeySecret) throw new Error('shared_connection_unavailable');
  const target = new URL(config.apiUrl);
  if (
    target.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.username ||
    target.password
  )
    throw new Error('shared_host_unavailable');
  return fetch(new URL('/api/plugins/chatgpt-dot/shared-mcp', target), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-key-secret': config.agentKeySecret },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
}

async function hostReply(body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await callDotHost(body);
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('shared_response_too_large');
      chunks.push(part.value);
    }
    return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
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

export async function sharedDotRpc(body: unknown): Promise<{ status: number; body: unknown } | null> {
  const parsed = request.safeParse(body);
  if (!parsed.success) return null; // SDK retains legacy request/error semantics.
  const rpc = parsed.data;
  if (rpc.method === 'server/discover')
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          resultType: 'complete',
          supportedVersions: [MODERN_VERSION, '2025-11-25'],
          capabilities: { tools: {}, events: {} },
        },
      },
    };
  if (
    rpc.method === 'initialize' &&
    rpc.params &&
    typeof rpc.params === 'object' &&
    'protocolVersion' in rpc.params &&
    rpc.params.protocolVersion === MODERN_VERSION
  ) {
    if (!initialization.safeParse(rpc.params).success)
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32602, message: 'Invalid initialization parameters' },
        },
      };
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          protocolVersion: MODERN_VERSION,
          capabilities: { tools: {}, events: {} },
          serverInfo,
        },
      },
    };
  }
  if (!RPC_METHODS.has(rpc.method)) return null;
  try {
    return await hostReply(rpc);
  } catch {
    return { status: 503, body: { error: 'shared_dot_host_unavailable' } };
  }
}

export function registerSharedDotTools(server: McpServer) {
  const schemas = [dotEventRefSchema, dotReplyArguments, dotImageArguments, dotAskArguments];
  for (const [index, tool] of DOT_TOOLS.entries()) {
    const schema = schemas[index];
    if (!schema) throw new Error('dot_tool_contract_missing_schema');
    const registered = server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: schema,
        annotations: tool.annotations,
      },
      async (input: unknown): Promise<CallToolResult> => {
        const argumentsResult = schema.safeParse(input);
        if (!argumentsResult.success)
          return { isError: true, content: [{ type: 'text', text: 'Invalid dot parameters' }] };
        try {
          const result = await hostReply({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: tool.name,
              arguments: argumentsResult.data,
            },
          });
          const parsed = z
            .object({
              result: z
                .object({
                  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
                  structuredContent: z.record(z.unknown()).optional(),
                  isError: z.boolean().optional(),
                })
                .passthrough(),
            })
            .safeParse(result.body);
          if (result.status === 200 && parsed.success) return parsed.data.result;
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(result.body) }] };
        } catch {
          return { isError: true, content: [{ type: 'text', text: 'Dot Host unavailable; no reply was confirmed.' }] };
        }
      },
    );
    registerCoCreatorPresentation(server, tool.name, registered);
  }
}
