import { sharedToolAuthorizer } from './shared-tool-authorization.js';
/**
 * Member MCP gateway — Streamable HTTP MCP endpoint for ACP members (F306 Phase B).
 *
 * iCode rejects client-injected stdio MCP servers, so members reach the
 * canonical cat-cafe tools over HTTP instead. This module only adds transport
 * and identity binding; it reuses the canonical tool registry
 * (server-toolsets) and the per-turn credential scope (withInvocationCredentials),
 * so tool handlers callback to the API with x-invocation-id / x-callback-token
 * exactly like stdio MCP children.
 *
 * Contract:
 *  - credentials travel ONLY in request headers; query-string credentials and
 *    forwarded headers are rejected before any verification
 *  - every request is verified against the live invocation registry (fail-closed);
 *    the verified record — never the request body — decides member identity
 *  - the tool surface follows the member's resolved families
 *  - responses never echo credential material; logs never include headers
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import {
  registerAudioToolset,
  registerCollabToolset,
  registerFinanceToolset,
  registerLimbToolset,
  registerMemoryToolset,
  registerSignalToolset,
  type ToolsetEnv,
} from './server-toolsets.js';
import { parseSharedInvocationContext, type SharedInvocationContext } from './shared-invocation-context.js';
import { withInvocationCredentials } from './tools/invocation-auth.js';

export type { ToolsetEnv } from './server-toolsets.js';

export type MemberToolFamily = 'collab' | 'memory' | 'signals' | 'limb' | 'audio' | 'finance';

export interface MemberGatewayCredentialContext {
  invocationId: string;
  callbackToken: string;
  catId: string;
  threadId: string;
  userId: string;
  /** API base URL the in-process tool handlers must callback to. */
  apiBaseUrl: string;
  /**
   * Per-invocation policy projection for tool filtering. The API host's own
   * process env is not member policy: the verifier must build this from the
   * invocation record (read-only / collective profile) so ambient host
   * READONLY/agent-key settings can neither widen nor narrow the member.
   */
  toolsetEnv: ToolsetEnv;
  sharedContext?: SharedInvocationContext;
}

export type MemberGatewayVerifyResult =
  | { ok: true; context: MemberGatewayCredentialContext }
  | { ok: false; reason: string };

export interface MemberGatewayDeps {
  verify(input: { invocationId: string; callbackToken: string }): Promise<MemberGatewayVerifyResult>;
  resolveFamilies(input: {
    catId: string;
    sharedContext?: SharedInvocationContext;
  }): Promise<readonly MemberToolFamily[]> | readonly MemberToolFamily[];
  log?: { warn(payload: Record<string, unknown>, message: string): void };
}

const SERVER_NAME = 'cat-cafe-member';
const SERVER_VERSION = '1.0.0';

const INVOCATION_HEADER = 'x-invocation-id';
const CALLBACK_TOKEN_HEADER = 'x-callback-token';

/** Requests arriving with these headers did not originate from our loopback client. */
const FORWARDED_HEADER_NAMES = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
] as const;

/** Credentials must never ride in the URL. */
const QUERY_CREDENTIAL_PARAMS = ['token', 'access_token', 'authorization', 'api_key'] as const;

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const FAMILY_REGISTRARS: Record<MemberToolFamily, (server: McpServer, env: ToolsetEnv) => void> = {
  collab: registerCollabToolset,
  memory: registerMemoryToolset,
  signals: registerSignalToolset,
  limb: registerLimbToolset,
  audio: registerAudioToolset,
  finance: registerFinanceToolset,
};

/**
 * Build the request handler for the member gateway.
 *
 * The returned function is transport-agnostic about the host server: it takes
 * the raw Node request/response plus the already-parsed JSON body, so the API
 * (Fastify + reply.hijack) or a plain node http server can host it.
 */
export function createMemberGatewayHandler(
  deps: MemberGatewayDeps,
): (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void> {
  const log = deps.log ?? { warn() {} };
  // Request-owned cancellation only. No session/replay/authority is retained here.
  const activeRequests = new Map<string, AbortController>();
  // Reuse only the SDK schema compiler. Protocol servers, tool handlers and
  // invocation authority remain request-owned; no principal enters this cache.
  let sharedSchemaValidator: AjvJsonSchemaValidator | undefined;

  return async function handleMemberGatewayRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    for (const name of FORWARDED_HEADER_NAMES) {
      if (req.headers[name] !== undefined) {
        sendJson(res, 403, { error: 'forwarded_headers_rejected' });
        return;
      }
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const shared = url.searchParams.get('shared') === '1';
    if (
      shared &&
      (req.headers.origin !== undefined ||
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? ''))
    ) {
      sendJson(res, 403, { error: 'shared_loopback_only' });
      return;
    }
    if (Number(req.headers['content-length'] ?? 0) > 1024 * 1024) {
      sendJson(res, 413, { error: 'request_too_large' });
      return;
    }
    for (const key of QUERY_CREDENTIAL_PARAMS) {
      if (url.searchParams.has(key)) {
        sendJson(res, 403, { error: 'query_credentials_rejected' });
        return;
      }
    }

    const invocationId = readHeader(req, INVOCATION_HEADER);
    const callbackToken = readHeader(req, CALLBACK_TOKEN_HEADER);
    if (!invocationId || !callbackToken) {
      sendJson(res, 401, { error: 'missing_credentials' });
      return;
    }

    let verified: MemberGatewayVerifyResult;
    try {
      verified = await deps.verify({ invocationId, callbackToken });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'member gateway verify failed');
      sendJson(res, 500, { error: 'verify_failed' });
      return;
    }
    if (!verified.ok) {
      // Typed reason only — never echo credentials.
      sendJson(res, 401, { error: verified.reason });
      return;
    }
    const { context } = verified;
    // The original principal chooses its authority model. Omitting a query
    // flag must never turn a shared invocation into an ambient Host reader.
    if (context.sharedContext !== undefined && !shared) {
      sendJson(res, 403, { error: 'shared_transport_required' });
      return;
    }
    let sharedContext: SharedInvocationContext | undefined;
    if (shared) {
      try {
        sharedContext = parseSharedInvocationContext(context.sharedContext);
      } catch {
        sendJson(res, 401, { error: 'shared_context_unavailable' });
        return;
      }
      if (
        context.invocationId !== invocationId ||
        context.callbackToken !== callbackToken ||
        !context.catId ||
        !context.userId ||
        !context.threadId ||
        !context.apiBaseUrl
      ) {
        sendJson(res, 401, { error: 'shared_identity_unavailable' });
        return;
      }
    }

    const connectionId = readHeader(req, 'x-mcp-connection-id');
    if (shared && (!connectionId || !/^[A-Za-z0-9_-]{1,160}$/.test(connectionId))) {
      sendJson(res, 401, { error: 'shared_connection_unavailable' });
      return;
    }
    const body = parsedBody && typeof parsedBody === 'object' ? (parsedBody as Record<string, unknown>) : undefined;
    const params =
      body?.params && typeof body.params === 'object' ? (body.params as Record<string, unknown>) : undefined;
    const keyFor = (id: string | number) => JSON.stringify([invocationId, connectionId, id]);
    if (shared && body?.method === 'notifications/cancelled') {
      const id = params?.requestId;
      if (typeof id !== 'string' && typeof id !== 'number') {
        sendJson(res, 400, { error: 'invalid_request_id' });
        return;
      }
      activeRequests.get(keyFor(id))?.abort();
      res.writeHead(202);
      res.end();
      return;
    }
    const requestKey =
      shared && (typeof body?.id === 'string' || typeof body?.id === 'number') ? keyFor(body.id) : undefined;
    if (requestKey && activeRequests.has(requestKey)) {
      sendJson(res, 409, { error: 'request_already_active' });
      return;
    }
    const controller = new AbortController();
    if (requestKey) activeRequests.set(requestKey, controller);
    try {
      let families: readonly MemberToolFamily[];
      try {
        families = await deps.resolveFamilies({ catId: context.catId, ...(sharedContext ? { sharedContext } : {}) });
        if (sharedContext) families = families.filter((family) => sharedContext.families.includes(family));
        const requestedFamily = url.searchParams.get('family');
        if (requestedFamily) {
          if (!families.includes(requestedFamily as MemberToolFamily)) {
            sendJson(res, 403, { error: 'family_not_allowed' });
            return;
          }
          families = families.filter((family) => family === requestedFamily);
        }
        controller.signal.throwIfAborted();
      } catch (err) {
        log.warn(
          { catId: context.catId, err: err instanceof Error ? err.message : String(err) },
          'member gateway tool surface resolution failed',
        );
        sendJson(res, 500, { error: 'surface_unavailable' });
        return;
      }

      const requested = url.searchParams.get('family') as MemberToolFamily | null;
      const schemaOptions = shared
        ? { jsonSchemaValidator: (sharedSchemaValidator ??= new AjvJsonSchemaValidator()) }
        : {};
      const server =
        shared && requested
          ? new McpServer(
              { name: `cat-cafe-${requested}-mcp`, version: '0.1.0' },
              { ...schemaOptions, instructions: SERVER_INSTRUCTIONS[requested] },
            )
          : new McpServer(
              { name: shared ? 'cat-cafe-mcp' : SERVER_NAME, version: shared ? '0.1.0' : SERVER_VERSION },
              schemaOptions,
            );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      try {
        // Registration runs inside the scope: principal/schema resolution at
        // register time must see the verified invocation, and a registration
        // failure lands in this 500 path instead of escaping after reply.hijack.
        await withInvocationCredentials(
          {
            invocationId: context.invocationId,
            callbackToken: context.callbackToken,
            apiUrl: context.apiBaseUrl,
            catId: context.catId,
            userId: context.userId,
            threadId: context.threadId,
            ...(sharedContext
              ? {
                  sharedContext,
                  requestSignal: controller.signal,
                  authorizeTool: sharedToolAuthorizer(deps, context, sharedContext, families, controller.signal),
                }
              : {}),
          },
          async () => {
            for (const family of new Set(families)) {
              FAMILY_REGISTRARS[family]?.(server, context.toolsetEnv);
            }
            await server.connect(transport);
            await transport.handleRequest(req, res, parsedBody);
          },
        );
      } catch (err) {
        log.warn(
          { catId: context.catId, err: err instanceof Error ? err.message : String(err) },
          'member gateway request failed',
        );
        sendJson(res, 500, { error: 'internal_error' });
      } finally {
        await server.close().catch(() => {});
      }
    } finally {
      if (requestKey) activeRequests.delete(requestKey);
    }
  };
}
