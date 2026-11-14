import { Buffer } from 'node:buffer';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DESKTOP_CLOUD_PRO_PHASE0_ALLOWED_TOOLS } from './server-toolsets.js';
import { getCallbackConfig } from './tools/callback-tools.js';

const MAX_SURFACE_BYTES = 512 * 1024;
const MAX_CALL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOOLS = 32;
const MAX_EVENTS = 16;

const rpcResponse = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]),
    result: z.record(z.unknown()).optional(),
    error: z.record(z.unknown()).optional(),
  })
  .passthrough();
const tool = z
  .object({
    name: z.string().min(1).max(128),
    title: z.string().max(256).optional(),
    description: z.string().max(16_384).optional(),
    inputSchema: z.object({ type: z.literal('object') }).passthrough(),
    outputSchema: z
      .object({ type: z.literal('object') })
      .passthrough()
      .optional(),
    annotations: z.record(z.unknown()).optional(),
    execution: z.record(z.unknown()).optional(),
    _meta: z.record(z.unknown()).optional(),
  })
  .strict();
const event = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(16_384).optional(),
    argumentsSchema: z.record(z.unknown()).optional(),
  })
  .passthrough();

export interface SharedExtensionSurface {
  readonly tools: readonly Tool[];
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly toolNames: ReadonlySet<string>;
}

function sharedHostUrl(): { url: URL; agentKey: string } | null {
  const config = getCallbackConfig({ forceAgentKey: true });
  if (!config?.agentKeySecret) return null;
  const base = new URL(config.apiUrl);
  if (
    base.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
    base.username ||
    base.password
  )
    return null;
  return { url: new URL('/api/plugin-runtime/shared/handle', base), agentKey: config.agentKeySecret };
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<{ value: unknown; bytes: number }> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximumBytes) throw new Error('shared_extension_response_too_large');
      chunks.push(part.value);
    }
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, bytes };
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export async function callSharedExtension(body: Readonly<Record<string, unknown>>): Promise<unknown | null> {
  const target = sharedHostUrl();
  if (!target) return null;
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-key-secret': target.agentKey },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404 || response.status === 409 || response.status === 503) return null;
    if (!response.ok) return null;
    const method = typeof body.method === 'string' ? body.method : '';
    const maximumBytes =
      method === 'tools/list' || method === 'events/list' ? MAX_SURFACE_BYTES : MAX_CALL_RESPONSE_BYTES;
    return (await readBoundedJson(response, maximumBytes)).value;
  } catch {
    return null;
  }
}

function uniqueNames(values: readonly { name: string }[]): boolean {
  return new Set(values.map((value) => value.name)).size === values.length;
}

export async function loadSharedExtensionSurface(): Promise<SharedExtensionSurface | null> {
  const [toolsRaw, eventsRaw] = await Promise.all([
    callSharedExtension({ jsonrpc: '2.0', id: 'surface-tools', method: 'tools/list', params: {} }),
    callSharedExtension({ jsonrpc: '2.0', id: 'surface-events', method: 'events/list', params: {} }),
  ]);
  const toolsResponse = rpcResponse.safeParse(toolsRaw);
  const eventsResponse = rpcResponse.safeParse(eventsRaw);
  if (!toolsResponse.success || !eventsResponse.success) return null;
  const listedTools = z
    .object({ resultType: z.literal('complete').optional(), tools: z.array(tool).max(MAX_TOOLS) })
    .strict()
    .safeParse(toolsResponse.data.result);
  const listedEvents = z
    .object({ resultType: z.literal('complete').optional(), events: z.array(event).max(MAX_EVENTS) })
    .strict()
    .safeParse(eventsResponse.data.result);
  if (!listedTools.success || !listedEvents.success) return null;
  if (
    !uniqueNames(listedTools.data.tools) ||
    !uniqueNames(listedEvents.data.events) ||
    listedTools.data.tools.some((definition) => DESKTOP_CLOUD_PRO_PHASE0_ALLOWED_TOOLS.has(definition.name))
  )
    return null;
  const tools = [...listedTools.data.tools].sort((left, right) => left.name.localeCompare(right.name));
  const events = [...listedEvents.data.events].sort((left, right) => left.name.localeCompare(right.name));
  const serialized = JSON.stringify([tools, events]);
  if (Buffer.byteLength(serialized) > MAX_SURFACE_BYTES) return null;
  return {
    tools: tools as readonly Tool[],
    events,
    toolNames: new Set(tools.map((value) => value.name)),
  };
}

export function sharedExtensionRpcMethod(body: unknown): { method: string; toolName?: string } | null {
  const parsed = z
    .object({
      jsonrpc: z.literal('2.0'),
      id: z.union([z.string(), z.number(), z.null()]),
      method: z.string(),
      params: z.unknown().optional(),
    })
    .strict()
    .safeParse(body);
  if (!parsed.success) return null;
  if (parsed.data.method === 'tools/call') {
    const call = z
      .object({ name: z.string(), arguments: z.unknown().optional() })
      .passthrough()
      .safeParse(parsed.data.params);
    return call.success ? { method: parsed.data.method, toolName: call.data.name } : { method: parsed.data.method };
  }
  return { method: parsed.data.method };
}
