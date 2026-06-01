/**
 * F174 Phase D1 — GET /api/debug/callback-auth (AC-D3).
 *
 * Returns the live failure-telemetry snapshot so operators can triage
 * callback auth issues without Prometheus / log tails. Shape matches
 * `getCallbackAuthFailureSnapshot()` from callback-auth-telemetry.
 *
 * Security history (PR #1377): endpoint was originally public, then
 * progressively hardened through session + owner gate. See PR #821
 * (#794) for the unified gate migration.
 *
 * Current design: session required + resolveOwnerGate(). When
 * DEFAULT_OWNER_USER_ID is configured, only the owner can access.
 * When unconfigured (single-user local mode), any valid session passes.
 */

import { createCatId } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import type { CallbackAuthSystemMessageNotifier } from './callback-auth-system-message.js';
import {
  getCallbackAuthFailureSnapshot,
  getCallbackAuthLastViewedAt,
  markCallbackAuthViewed,
} from './callback-auth-telemetry.js';

function resolveSessionUserId(request: FastifyRequest): string | null {
  const fromSession = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (typeof fromSession === 'string' && fromSession.trim().length > 0) {
    return fromSession.trim();
  }
  return null;
}

/** Owner-gate guard shared by GET snapshot + POST hide-similar. Returns null on success. */
function checkOwnerGate(request: FastifyRequest, reply: FastifyReply): { error: string } | null {
  const operator = resolveSessionUserId(request);
  if (!operator) {
    reply.status(401);
    return { error: 'Authenticated session required (establish via GET /api/session)' };
  }
  // Network guard: non-direct-loopback requests without a configured owner are
  // rejected to prevent LAN/proxied access to debug telemetry (#794).
  if (!isDirectLoopbackRequest(request) && !process.env.DEFAULT_OWNER_USER_ID?.trim()) {
    reply.status(403);
    return { error: 'Debug endpoints from non-localhost require DEFAULT_OWNER_USER_ID to be configured' };
  }
  const gateResult = resolveOwnerGate(operator, {
    errorMessage: 'Callback auth telemetry can only be accessed by the configured owner',
  });
  if (gateResult) {
    reply.status(gateResult.status);
    return { error: gateResult.error };
  }
  return null;
}

const hideSimilarBodySchema = z.object({
  reason: z.enum(['expired', 'invalid_token', 'unknown_invocation', 'stale_invocation', 'missing_creds']),
  tool: z.string().min(1),
  catId: z.string().min(1),
  // Cloud Codex P1 #1397: scoped to thread + user so a hide doesn't
  // cross-suppress unrelated conversations or tenants.
  threadId: z.string().min(1),
  userId: z.string().min(1),
});

// F174 D2b-2 rev3 — Cloud Codex P2 #1425: optional `viewedUpTo` timestamp.
// Without this, panel mount → markViewed advances lastViewedAt to "now",
// permanently clearing failures that occurred between last 30s poll and
// panel open (user never saw them). With `viewedUpTo` = snapshot's
// effective "as of" time, only ack failures actually in the rendered
// snapshot — newer failures stay unviewed until the next poll.
const markViewedBodySchema = z
  .object({
    viewedUpTo: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

export interface CallbackAuthDebugRouteOptions {
  /** F174 D2b-1 — when wired, exposes POST /api/debug/callback-auth/hide-similar */
  notifier?: Pick<CallbackAuthSystemMessageNotifier, 'hideSimilar'>;
}

export function registerCallbackAuthDebugRoute(
  app: FastifyInstance,
  options: CallbackAuthDebugRouteOptions = {},
): void {
  app.get('/api/debug/callback-auth', async (request, reply) => {
    const gateError = checkOwnerGate(request, reply);
    if (gateError) return gateError;
    return getCallbackAuthFailureSnapshot();
  });

  // F174 D2b-2 rev3: mark callback-auth telemetry as viewed. Frontend calls
  // this when user opens observability/callback-auth subtab → snapshot's
  // unviewedFailures24h drops to 0 → HubButton badge clears. Owner-gated
  // (same gate as snapshot read — telemetry exposure must match write surface).
  //
  // Cloud Codex P2 #1425: accept optional `viewedUpTo` so frontend can
  // pass the snapshot's effective "as of" time, preventing acknowledgement
  // of failures that occurred between last poll and panel open. Server
  // clamps to <= Date.now() to defend against future timestamps.
  app.post('/api/debug/callback-auth/mark-viewed', async (request, reply) => {
    const gateError = checkOwnerGate(request, reply);
    if (gateError) return gateError;
    const parsed = markViewedBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const now = Date.now();
    const provided = parsed.data?.viewedUpTo;
    const viewedAt = provided !== undefined ? Math.min(provided, now) : now;
    markCallbackAuthViewed(viewedAt);
    return { ok: true, viewedAt, lastViewedAt: getCallbackAuthLastViewedAt() };
  });

  // F174 D2b-1: hide-similar opt-out (24h suppression for the (reason, tool, catId) tuple).
  // Only exposed when the D2b-1 notifier is wired so that endpoint surface mirrors
  // capability — back-compat callers without the notifier get 404 (route absent).
  if (options.notifier) {
    const { notifier } = options;
    app.post('/api/debug/callback-auth/hide-similar', async (request, reply) => {
      const gateError = checkOwnerGate(request, reply);
      if (gateError) return gateError;
      const parsed = hideSimilarBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid body', details: parsed.error.issues };
      }
      notifier.hideSimilar({
        reason: parsed.data.reason,
        tool: parsed.data.tool,
        catId: createCatId(parsed.data.catId),
        threadId: parsed.data.threadId,
        userId: parsed.data.userId,
      });
      return { ok: true };
    });
  }
}
