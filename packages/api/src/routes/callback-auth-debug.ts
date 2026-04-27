/**
 * F174 Phase D1 — GET /api/debug/callback-auth (AC-D3).
 *
 * Returns the live failure-telemetry snapshot so operators can triage
 * callback auth issues without Prometheus / log tails. Shape matches
 * `getCallbackAuthFailureSnapshot()` from callback-auth-telemetry.
 *
 * Cloud Codex P1 sequence (PR #1377) walked through the bypass classes:
 *   - 18:50Z: public endpoint leaked per-tool failure counts + catIds
 *   - 19:11Z: resolveHeaderUserId trusted-origin fallback to 'default-user'
 *   - 19:31Z: raw X-Cat-Cafe-User header spoofable by any client
 *   - 20:30Z: same-origin browser GET can omit Origin
 *   - 20:46Z: DEFAULT_OWNER_USER_ID mismatch made endpoint unreachable
 *   - 21:00Z: `/api/session` mints sessions for anonymous callers —
 *             "has session" ≠ "authorized", so owner check IS required
 *
 * Final design: two-layer gate — session required AND session user must
 * match the configured owner. Owner defaults to 'default-user' (what
 * F156 D-1 session plugin currently mints). Operators running with
 * non-default DEFAULT_OWNER_USER_ID get 403 until session minting is
 * extended (F156 future work) — better fail-closed than silently public.
 */

import { createCatId } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
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
  const ownerId = process.env.DEFAULT_OWNER_USER_ID?.trim();
  if (!ownerId) {
    reply.status(403);
    return { error: 'Callback auth telemetry requires DEFAULT_OWNER_USER_ID to be explicitly configured' };
  }
  if (operator !== ownerId) {
    reply.status(403);
    return { error: 'Callback auth telemetry can only be accessed by the configured owner' };
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
