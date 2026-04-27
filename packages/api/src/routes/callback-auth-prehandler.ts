/**
 * Unified callback auth preHandler (#476)
 *
 * Extracts X-Invocation-Id + X-Callback-Token from HTTP headers,
 * verifies via InvocationRegistry, and decorates request.callbackAuth.
 */

import type { AgentKeyVerifyResult, CallbackPrincipal } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { InvocationRecord, VerifyResult } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { CallbackAuthSystemMessageNotifier } from './callback-auth-system-message.js';
import { recordCallbackAuthFailure, recordLegacyFallbackHit } from './callback-auth-telemetry.js';
import { makeCallbackAuthError } from './callback-errors.js';
import { derivePrincipal } from './callback-scope-helpers.js';

/**
 * F174 Phase D1: derive a concise tool name from the request URL for
 * `cat_cafe.callback_auth.failures{callback.tool}` attribute. Strips
 * `/api/callbacks/` prefix and any query string; returns `unknown` if
 * the URL doesn't follow the callback route shape (defensive default).
 */
function callbackToolFromUrl(url: string): string {
  const path = url.split('?')[0];
  const match = path.match(/^\/api\/callbacks\/([^/]+)/);
  return match ? match[1] : 'unknown';
}

declare module 'fastify' {
  interface FastifyRequest {
    callbackAuth?: InvocationRecord;
    callbackPrincipal?: CallbackPrincipal;
  }
}

interface CallbackAuthRegistry {
  verify(invocationId: string, callbackToken: string): Promise<VerifyResult>;
  /**
   * F174 D2b-1: pure record read, ignoring TTL. Used by the in-context
   * surface to recover threadId/catId/userId for the notifier even when
   * verify() has just deleted the record on `expired` (砚砚 P1 #1397
   * review — getRecord() also deletes on expired so it can't be used for
   * this purpose).
   */
  peekRecord?(invocationId: string): Promise<InvocationRecord | null>;
}

interface AgentKeyAuthRegistry {
  verify(secret: string): Promise<AgentKeyVerifyResult>;
}

export interface CallbackAuthHookOptions {
  /** F174 D2b-1: in-context system message notifier for surface-able 401s. */
  notifier?: Pick<CallbackAuthSystemMessageNotifier, 'notify'>;
  /** F178 Phase C: agent-key registry for persistent agent auth. */
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

/** Register the callbackAuth decoration + preHandler on a Fastify instance.
 *
 *  Behavior:
 *  1. Try X-Invocation-Id + X-Callback-Token headers (preferred)
 *  2. Fallback: read from body/query (legacy compat window, logs deprecation)
 *  3. Neither present → no-op (panel / non-callback request)
 *  4. Credentials present but invalid → immediate 401 (fail-closed, #474)
 *  5. F174 D2b-1: if `options.notifier` is provided + registry has getRecord,
 *     a 401 with surface-able reason (`expired`/`invalid_token`) triggers
 *     an in-context system message in the affected thread.
 */
export function registerCallbackAuthHook(
  app: FastifyInstance,
  registry: CallbackAuthRegistry,
  options: CallbackAuthHookOptions = {},
): void {
  if (!app.hasRequestDecorator('callbackAuth')) {
    app.decorateRequest('callbackAuth', undefined);
  }
  if (!app.hasRequestDecorator('callbackPrincipal')) {
    app.decorateRequest('callbackPrincipal', undefined);
  }
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // F174-C (cloud Codex P2 #1368, 05de7c98b): refresh-token route does its
    // own atomic verifyLatest in preValidation and pre-populates callbackAuth.
    // Skip the second verify here to avoid double-slide and to preserve the
    // atomicity guarantee against the preValidation/preHandler race window.
    if (request.callbackAuth) return;

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

    // F178 Phase C: agent-key secret header (only checked when no invocation creds)
    const agentKeySecret = firstHeaderValue(request.headers['x-agent-key-secret']);

    if (!invocationId && !callbackToken) {
      if (agentKeySecret && options.agentKeyRegistry) {
        const tool = callbackToolFromUrl(request.url);
        const akResult = await options.agentKeyRegistry.verify(agentKeySecret);
        if (!akResult.ok) {
          recordCallbackAuthFailure({ reason: akResult.reason, tool });
          reply.status(401).send(makeCallbackAuthError(akResult.reason));
          return;
        }
        request.callbackPrincipal = derivePrincipal(akResult.record);
        return;
      }
      return;
    }
    const tool = callbackToolFromUrl(request.url);
    if (!invocationId || !callbackToken) {
      recordCallbackAuthFailure({ reason: 'missing_creds', tool });
      reply.status(401).send(makeCallbackAuthError('missing_creds'));
      return;
    }
    // F174 D2b-1 (砚砚 P1 #1397 review): capture record metadata BEFORE verify().
    // verify() deletes the record on `expired`, and getRecord() also deletes on
    // expired — without this peek, the most important surface scenario ("token
    // 干半小时过期") would silently miss the in-context message because the
    // record was already gone by the time we tried to look it up. peekRecord()
    // is non-destructive; the small race with concurrent verify is acceptable.
    const recordSnapshot =
      options.notifier && registry.peekRecord ? await registry.peekRecord(invocationId).catch(() => null) : null;

    const result = await registry.verify(invocationId, callbackToken);
    if (!result.ok) {
      recordCallbackAuthFailure({ reason: result.reason, tool });
      // Surface in-context using the snapshot captured before verify ran.
      // Notifier handles the surface decision (skips stale_invocation, etc).
      if (options.notifier && recordSnapshot) {
        try {
          await options.notifier.notify({
            threadId: recordSnapshot.threadId,
            catId: recordSnapshot.catId,
            userId: recordSnapshot.userId,
            reason: result.reason,
            tool,
          });
        } catch (err) {
          request.log.warn(
            { err, invocationId, reason: result.reason, tool },
            '[F174-D2b-1] callback auth notifier failed (non-fatal)',
          );
        }
      }
      reply.status(401).send(makeCallbackAuthError(result.reason));
      return;
    }
    if (legacy) {
      // F174 Phase F (AC-F3): track legacy fallback usage so we know when the
      // compat path is safe to delete (zero hits across a release window).
      recordLegacyFallbackHit({ tool });
      request.log.warn(
        { invocationId, path: request.url },
        '[#476 DEPRECATED] Callback credentials received via body/query — migrate to X-Invocation-Id / X-Callback-Token headers',
      );
    }
    request.callbackAuth = result.record;
    request.callbackPrincipal = derivePrincipal(result.record);
  });
}

/**
 * F174-C — single source of truth for "what callback creds does this request
 * actually present?" Used by both preHandler and refresh-token preValidation
 * so the cooldown decision matches the auth decision (gpt52 P1 #3 #1368:
 * mismatched rules let mixed-source bad-auth burn cooldown slot).
 *
 * Rule (mirror of preHandler's auth flow):
 *   - If both headers present → headers win (returns the header pair)
 *   - Else if BOTH headers absent and legacy body/query has both → legacy creds
 *   - Otherwise (partial headers, mixed source, etc.) → null (request will
 *     be rejected by preHandler as missing_creds)
 *
 * Returns canonical creds (both fields present) or null. Caller can detect
 * "auth attempt happened" separately if it needs to distinguish panel path
 * from missing_creds.
 */
export function extractCallbackCredentials(
  request: FastifyRequest,
): { invocationId: string; callbackToken: string } | null {
  const headerInv = firstHeaderValue(request.headers['x-invocation-id']);
  const headerTok = firstHeaderValue(request.headers['x-callback-token']);

  if (headerInv && headerTok) {
    return { invocationId: headerInv, callbackToken: headerTok };
  }
  // Legacy fallback ONLY when both headers absent (matches preHandler line 40).
  // Mixed-source (e.g. header inv + body tok) explicitly returns null so
  // cooldown is never claimed for a request that preHandler will 401.
  if (!headerInv && !headerTok) {
    const legacy = extractLegacyCredentials(request);
    if (legacy?.invocationId && legacy?.callbackToken) {
      return { invocationId: legacy.invocationId, callbackToken: legacy.callbackToken };
    }
  }
  return null;
}

/**
 * Extract legacy credentials from body (POST) or query (GET).
 * Returns partial results so the caller's `!id || !token` guard
 * rejects malformed requests (fail-closed, consistent with headers).
 *
 * Exported for F174-C refresh-token cooldown — that hook needs to recognize
 * legacy creds path so cooldown applies uniformly (cloud Codex P1 #1368).
 */
export function extractLegacyCredentials(
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

/** Require callbackPrincipal on the request — returns principal or sends 401. */
export function requireCallbackPrincipal(request: FastifyRequest, reply: FastifyReply): CallbackPrincipal | null {
  if (request.callbackPrincipal) return request.callbackPrincipal;
  reply.status(401);
  recordCallbackAuthFailure({ reason: 'unknown_invocation', tool: callbackToolFromUrl(request.url) });
  reply.send(makeCallbackAuthError('unknown_invocation'));
  return null;
}

/** Require callbackAuth on the request — returns record or sends 401. */
export function requireCallbackAuth(request: FastifyRequest, reply: FastifyReply): InvocationRecord | null {
  if (request.callbackAuth) return request.callbackAuth;
  reply.status(401);
  // unknown_invocation: preHandler didn't decorate the request, which means
  // either creds were missing entirely (handled above) or the route was hit
  // without going through the preHandler chain. Surfacing as unknown is safer
  // than expired (we don't actually know the registry state here).
  recordCallbackAuthFailure({ reason: 'unknown_invocation', tool: callbackToolFromUrl(request.url) });
  reply.send(makeCallbackAuthError('unknown_invocation'));
  return null;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value)) return value[0] || undefined;
  return undefined;
}
