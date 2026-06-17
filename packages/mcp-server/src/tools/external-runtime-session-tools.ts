import { z } from 'zod';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

function resolveToolUserId(): string {
  return process.env['CAT_CAFE_USER_ID'] ?? 'default-user';
}

function resolveToolCatId(): string | undefined {
  return process.env['CAT_CAFE_CAT_ID'];
}

function buildUserAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'x-cat-cafe-user': resolveToolUserId(),
  };
  const catId = resolveToolCatId();
  if (catId) headers['x-cat-id'] = catId;
  return headers;
}

const runtimeSchema = z
  .literal('antigravity-desktop')
  .describe('External runtime identifier. Phase B supports antigravity-desktop.');

const agentKeyCatIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Persistent-agent identity selector. Required for shared Antigravity MCP when CAT_CAFE_AGENT_KEY_FILES is configured.',
  );

const bindingSchema = z
  .union([
    z.object({ mode: z.literal('orphan') }),
    z.object({ mode: z.literal('thread'), threadId: z.string().min(1) }),
  ])
  .optional()
  .describe('Optional binding target. Omit or use orphan for the hidden external runtime anchor.');

export const registerExternalRuntimeSessionInputSchema = {
  runtime: runtimeSchema,
  runtimeSessionId: z.string().min(1).describe('Antigravity cascade/session id'),
  runtimeConversationId: z.string().min(1).optional().describe('Optional Antigravity conversation id'),
  catId: z.string().min(1).describe('Cat id represented by the agent-key'),
  model: z.string().min(1).describe('Runtime model identity'),
  title: z.string().min(1).optional().describe('Optional human-readable IDE session title'),
  startedAt: z.number().finite().describe('Runtime session start timestamp in epoch milliseconds'),
  lastObservedAt: z.number().finite().optional().describe('Latest observed activity timestamp in epoch milliseconds'),
  binding: bindingSchema,
  agentKeyCatId: agentKeyCatIdSchema,
};

export const listExternalRuntimeSessionsInputSchema = {
  runtime: runtimeSchema.optional(),
  catId: z.string().min(1).optional().describe('Filter by cat id'),
  limit: z.number().int().min(1).max(100).optional().describe('Max sessions to return'),
};

export const readExternalRuntimeSessionInputSchema = {
  sessionId: z.string().min(1).describe('Clowder AI SessionRecord id'),
};

export async function handleRegisterExternalRuntimeSession(input: {
  runtime: 'antigravity-desktop';
  runtimeSessionId: string;
  runtimeConversationId?: string | undefined;
  catId: string;
  model: string;
  title?: string | undefined;
  startedAt: number;
  lastObservedAt?: number | undefined;
  binding?: { mode: 'orphan' } | { mode: 'thread'; threadId: string } | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  const body = {
    runtime: input.runtime,
    runtimeSessionId: input.runtimeSessionId,
    ...(input.runtimeConversationId ? { runtimeConversationId: input.runtimeConversationId } : {}),
    catId: input.catId,
    model: input.model,
    ...(input.title ? { title: input.title } : {}),
    startedAt: input.startedAt,
    ...(input.lastObservedAt !== undefined ? { lastObservedAt: input.lastObservedAt } : {}),
    ...(input.binding ? { binding: input.binding } : {}),
  };
  return callbackPost('/api/callbacks/external-runtime-sessions/register', body, {
    agentKeyCatId: input.agentKeyCatId,
    forceAgentKey: true,
  });
}

export async function handleListExternalRuntimeSessions(input: {
  runtime?: 'antigravity-desktop' | undefined;
  catId?: string | undefined;
  limit?: number | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams();
  if (input.runtime) params.set('runtime', input.runtime);
  if (input.catId) params.set('catId', input.catId);
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  const qs = params.toString();
  const url = `${API_URL}/api/external-runtime-sessions${qs ? `?${qs}` : ''}`;
  return fetchExternalRuntimeSessionJson(url, 'List external runtime sessions failed');
}

export async function handleReadExternalRuntimeSession(input: { sessionId: string }): Promise<ToolResult> {
  const url = `${API_URL}/api/external-runtime-sessions/${encodeURIComponent(input.sessionId)}`;
  return fetchExternalRuntimeSessionJson(url, 'Read external runtime session failed');
}

async function fetchExternalRuntimeSessionJson(url: string, failurePrefix: string): Promise<ToolResult> {
  try {
    const res = await fetch(url, { headers: buildUserAuthHeaders() });
    if (!res.ok) {
      return errorResult(`${failurePrefix} (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    return successResult(formatExternalRuntimeSessionResponse(data));
  } catch (err) {
    return errorResult(`${failurePrefix}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatExternalRuntimeSessionResponse(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n\nNext: cat_cafe_read_session_digest({ sessionId }) or cat_cafe_read_session_events({ sessionId, view: "handoff" })`;
}

export const externalRuntimeSessionCallbackTools = [
  {
    name: 'cat_cafe_register_external_runtime_session',
    description:
      'Register an Antigravity IDE-direct runtime session using persistent agent-key auth. ' +
      'Use when an IDE-direct conversation needs Clowder AI session-chain evidence without invocation callback credentials. ' +
      'Shared Antigravity MCP GOTCHA: pass agentKeyCatId so the right sidecar key is selected.',
    inputSchema: registerExternalRuntimeSessionInputSchema,
    handler: handleRegisterExternalRuntimeSession,
  },
] as const;

export const externalRuntimeSessionReadTools = [
  {
    name: 'cat_cafe_list_external_runtime_sessions',
    description:
      'List orphan, dispatched, or IDE-direct external runtime sessions by runtime, cat, and recent activity. ' +
      'Use when an external runtime session looks lost, detached from the current thread, or needs cross-runtime drilldown. ' +
      'Use before reading digest/events when there is no normal Clowder AI thread yet.',
    inputSchema: listExternalRuntimeSessionsInputSchema,
    handler: handleListExternalRuntimeSessions,
  },
  {
    name: 'cat_cafe_read_external_runtime_session',
    description:
      'Read one external runtime session metadata record and drilldown pointers. ' +
      'Use after list when you need the sessionId, runtime binding, digest pointer, or handoff event path for an external runtime session. ' +
      'After this, use cat_cafe_read_session_digest or cat_cafe_read_session_events with the returned sessionId.',
    inputSchema: readExternalRuntimeSessionInputSchema,
    handler: handleReadExternalRuntimeSession,
  },
] as const;

export const externalRuntimeSessionTools = [
  ...externalRuntimeSessionCallbackTools,
  ...externalRuntimeSessionReadTools,
] as const;
