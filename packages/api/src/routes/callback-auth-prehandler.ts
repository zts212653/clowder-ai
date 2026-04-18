/**
 * Unified callback auth preHandler (#476)
 *
 * Extracts X-Invocation-Id + X-Callback-Token from HTTP headers,
 * verifies via InvocationRegistry, and decorates request.callbackAuth.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    callbackAuth?: InvocationRecord;
  }
}

interface CallbackAuthRegistry {
  verify(invocationId: string, callbackToken: string): InvocationRecord | null;
}

/** Register the callbackAuth decoration + preHandler on a Fastify instance.
 *
 *  Behavior:
 *  1. Try X-Invocation-Id + X-Callback-Token headers (preferred)
 *  2. Fallback: read from body/query (legacy compat window, logs deprecation)
 *  3. Neither present → no-op (panel / non-callback request)
 *  4. Credentials present but invalid → immediate 401 (fail-closed, #474)
 */
export function registerCallbackAuthHook(app: FastifyInstance, registry: CallbackAuthRegistry): void {
  if (!app.hasRequestDecorator('callbackAuth')) {
    app.decorateRequest('callbackAuth', undefined);
  }
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    let invocationId = firstHeaderValue(request.headers['x-invocation-id']);
    let callbackToken = firstHeaderValue(request.headers['x-callback-token']);
    let legacy = false;

    // Fallback: body/query for legacy MCP clients (#476 compat window)
    if (!invocationId && !callbackToken) {
      const fromBody = extractLegacyCredentials(request);
      if (fromBody) {
        invocationId = fromBody.invocationId;
        callbackToken = fromBody.callbackToken;
        legacy = true;
      }
    }

    if (!invocationId && !callbackToken) return;
    if (!invocationId || !callbackToken) {
      reply.status(401).send(EXPIRED_CREDENTIALS_ERROR);
      return;
    }
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401).send(EXPIRED_CREDENTIALS_ERROR);
      return;
    }
    if (legacy) {
      request.log.warn(
        { invocationId, path: request.url },
        '[#476 DEPRECATED] Callback credentials received via body/query — migrate to X-Invocation-Id / X-Callback-Token headers',
      );
    }
    request.callbackAuth = record;
  });
}

/** Extract legacy credentials from body (POST) or query (GET).
 *  Returns partial results so the caller's `!id || !token` guard
 *  rejects malformed requests (fail-closed, consistent with headers). */
function extractLegacyCredentials(
  request: FastifyRequest,
): { invocationId: string | undefined; callbackToken: string | undefined } | null {
  const body = request.body as Record<string, unknown> | undefined;
  if (body) {
    const id = typeof body.invocationId === 'string' ? body.invocationId : undefined;
    const tok = typeof body.callbackToken === 'string' ? body.callbackToken : undefined;
    if (id || tok) return { invocationId: id, callbackToken: tok };
  }
  const query = request.query as Record<string, unknown> | undefined;
  if (query) {
    const id = typeof query.invocationId === 'string' ? query.invocationId : undefined;
    const tok = typeof query.callbackToken === 'string' ? query.callbackToken : undefined;
    if (id || tok) return { invocationId: id, callbackToken: tok };
  }
  return null;
}

/** Require callbackAuth on the request — returns record or sends 401. */
export function requireCallbackAuth(request: FastifyRequest, reply: FastifyReply): InvocationRecord | null {
  if (request.callbackAuth) return request.callbackAuth;
  reply.status(401);
  reply.send(EXPIRED_CREDENTIALS_ERROR);
  return null;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value)) return value[0] || undefined;
  return undefined;
}
