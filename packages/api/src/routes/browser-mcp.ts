/**
 * F333: the only door to the shared browser process.
 *
 * Every request re-verifies the invocation, its deployment and tool policy, and that this cat still
 * has the `shared-browser` capability in the invocation's project (a valid callback token is not a
 * browser grant). Only allowlisted headers plus API-derived identity reach the child; the callback
 * token never does. Child failures surface as errors — a browser action is never replayed.
 */
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { sharedRequestBoundaryRejection } from '@cat-cafe/mcp-server/dist/member-gateway.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveServersForCat } from '../config/capabilities/capability-orchestrator.js';
import { readInvocationMcpConfig } from '../config/capabilities/invoke-mcp-config.js';
import type { BrowserEndpoint } from '../domains/browser/BrowserProcess.js';
import {
  BROWSER_BINDING_HEADER,
  BROWSER_KEY_HEADER,
  BROWSER_THREAD_HEADER,
  BROWSER_WORKSPACE_HEADER,
} from '../domains/browser/browser-session-host.js';
import { SHARED_BROWSER_HTTP_PATH, SHARED_BROWSER_RESOLVER } from '../domains/browser/shared-browser-descriptor.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';

type VerifiedRecord = Extract<Awaited<ReturnType<InvocationRegistry['verifyLatest']>>, { ok: true }>['record'];

export interface BrowserMcpRouteOptions {
  registry: Pick<InvocationRegistry, 'verifyLatest' | 'isStartupRecoveryComplete'>;
  deploymentId: string;
  browser: { endpoint(): Promise<BrowserEndpoint> };
  /** Test seam; defaults to the invocation project's capability resolution. */
  hasSharedBrowser?: (record: VerifiedRecord) => boolean;
}

const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-protocol-version'] as const;
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control'] as const;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

export function hasSharedBrowserCapability(record: VerifiedRecord): boolean {
  const context = record.sharedMcpContext;
  if (!context) return false;
  const { config, accessScope } = readInvocationMcpConfig(context.capabilityRoot, context.workspaceRoot);
  if (!config) return false;
  return resolveServersForCat(config, record.catId, { accessScope }).some(
    (server) => server.enabled && server.resolver === SHARED_BROWSER_RESOLVER,
  );
}

export function registerBrowserMcpRoutes(app: FastifyInstance, options: BrowserMcpRouteOptions): void {
  const hasSharedBrowser = options.hasSharedBrowser ?? hasSharedBrowserCapability;
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    // Same local-only boundary as the shared member gateway (Sol5.6 R1 P1-3), before any verification.
    const rejection = sharedRequestBoundaryRejection(request.raw, { shared: true });
    if (rejection) return reply.status(rejection.status).send({ error: rejection.error });
    const invocationId = header(request.headers, 'x-invocation-id');
    const callbackToken = header(request.headers, 'x-callback-token');
    const connectionId = header(request.headers, 'x-mcp-connection-id');
    if (!invocationId || !callbackToken || !connectionId || !ID_PATTERN.test(connectionId))
      return reply.status(401).send({ error: 'browser_identity_required' });
    if (options.registry.isStartupRecoveryComplete?.() === false)
      return reply.status(503).send({ error: 'startup_recovery_pending' });
    const verified = await options.registry.verifyLatest(invocationId, callbackToken);
    if (!verified.ok) return reply.status(401).send({ error: 'invocation_not_current' });
    const record = verified.record;
    const context = record.sharedMcpContext;
    if (!context || context.deploymentId !== options.deploymentId || record.toolExecutionPolicy)
      return reply.status(403).send({ error: 'shared_browser_unavailable' });
    if (!ID_PATTERN.test(record.threadId)) return reply.status(403).send({ error: 'shared_browser_unavailable' });
    if (!hasSharedBrowser(record)) return reply.status(403).send({ error: 'shared_browser_not_enabled' });

    let endpoint: BrowserEndpoint;
    try {
      endpoint = await options.browser.endpoint();
    } catch {
      return reply.status(503).send({ error: 'browser_process_unavailable' });
    }
    const headers: Record<string, string> = {
      [BROWSER_KEY_HEADER]: endpoint.key,
      [BROWSER_THREAD_HEADER]: record.threadId,
      [BROWSER_WORKSPACE_HEADER]: context.workspaceRoot,
      // Opaque: the child can tell sessions apart without learning the invocation id.
      [BROWSER_BINDING_HEADER]: createHash('sha256').update(`${invocationId}:${connectionId}`).digest('hex'),
    };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = header(request.headers, name);
      if (value) headers[name] = value;
    }
    const body = request.method === 'POST' ? JSON.stringify(request.body ?? null) : undefined;
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));

    reply.hijack();
    const res = reply.raw;
    const upstream = httpRequest(
      { host: '127.0.0.1', port: endpoint.port, path: '/mcp', method: request.method, headers },
      (childRes) => {
        const out: Record<string, string> = {};
        for (const name of FORWARDED_RESPONSE_HEADERS) {
          const value = header(childRes.headers, name);
          if (value) out[name] = value;
        }
        res.writeHead(childRes.statusCode ?? 502, out);
        childRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'browser_process_failed' }));
    });
    res.on('close', () => upstream.destroy());
    upstream.end(body);
  };
  app.post(SHARED_BROWSER_HTTP_PATH, { bodyLimit: 4 * 1024 * 1024 }, handler);
  // Stateless edge: no server stream and no session to delete (MCP spec allows 405 for both).
  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.status(405).header('allow', 'POST').send({ error: 'method_not_allowed' });
  app.get(SHARED_BROWSER_HTTP_PATH, notAllowed);
  app.delete(SHARED_BROWSER_HTTP_PATH, notAllowed);
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
