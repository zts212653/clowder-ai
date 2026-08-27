/**
 * Session Hooks Routes — F24 Session Blindness Fix
 * API endpoints called by Claude Code CLI hooks during context compaction.
 *
 * POST /api/sessions/seal          — Hook-triggered seal (PreCompact calls this)
 * GET  /api/sessions/latest-digest — Get latest sealed session digest (SessionStart calls this)
 * POST /api/sessions/sop-bookmark  — Store SOP stage bookmark (F073 P4)
 * GET  /api/sessions/sop-bookmark  — Read SOP stage bookmark (F073 P4)
 *
 * Both endpoints use `cliSessionId` (Claude Code's session_id) to look up the
 * corresponding Clowder AI SessionRecord via `getByCliSessionId()`.
 */

import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ISessionSealer } from '../domains/cats/services/session/SessionSealer.js';
import type { TranscriptReader } from '../domains/cats/services/session/TranscriptReader.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import {
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
} from './callback-auth-prehandler.js';
import { createSessionCompactionSurface, type SessionCompactionSurfaceDeps } from './session-compaction-surface.js';

const sealSchema = z.object({
  cliSessionId: z.string().min(1).max(500),
  reason: z.string().min(1).max(200),
});

const sopBookmarkSchema = z.object({
  cliSessionId: z.string().min(1).max(500),
  skill: z.string().min(1).max(100),
  sopStage: z.string().min(1).max(100),
});

interface SessionHooksRouteOptions extends FastifyPluginOptions, SessionCompactionSurfaceDeps {
  sessionChainStore: ISessionChainStore;
  sessionSealer: ISessionSealer;
  transcriptReader: TranscriptReader;
  /** Invocation-scoped callback authority shared with the managed Claude child. */
  callbackRegistry: CallbackAuthRegistry;
}

function cliSessionIdFromHookRequest(request: FastifyRequest): string | undefined {
  const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : undefined;
  const query =
    request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : undefined;
  if (typeof body?.cliSessionId === 'string') return body.cliSessionId;
  return typeof query?.cliSessionId === 'string' ? query.cliSessionId : undefined;
}

function invocationOwnsSession(
  invocation: { userId: string; catId: string; threadId: string },
  session: { userId: string; catId: string; threadId: string },
): boolean {
  return (
    session.userId === invocation.userId &&
    session.catId === invocation.catId &&
    session.threadId === invocation.threadId
  );
}

export async function sessionHooksRoutes(app: FastifyInstance, opts: SessionHooksRouteOptions): Promise<void> {
  const { sessionChainStore, sessionSealer, callbackRegistry } = opts;
  const compactionSurface = createSessionCompactionSurface({
    ...opts,
    hookAuthenticationReady: () => callbackRegistry.isStartupRecoveryComplete?.() !== false,
  });

  registerCallbackAuthHook(app, callbackRegistry, { enforceToolExecutionPolicy: false });
  app.addHook('preHandler', async (request, reply) => {
    const invocation = requireCallbackAuth(request, reply);
    if (!invocation) return;
    const cliSessionId = cliSessionIdFromHookRequest(request);
    if (!cliSessionId) return;
    const session = await sessionChainStore.getByCliSessionId(cliSessionId);
    if (!session) return;
    if (!invocationOwnsSession(invocation, session)) {
      reply.status(403).send({ error: 'session_hook_scope_mismatch' });
    }
  });

  // POST /api/sessions/seal — Hook-triggered session seal
  // Called by f24-pre-compact.sh before Claude Code context compression.
  app.post('/api/sessions/seal', async (request, reply) => {
    const invocation = requireCallbackAuth(request, reply);
    if (!invocation) return;
    const parseResult = sealSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { cliSessionId, reason } = parseResult.data;

    // Look up Clowder AI session by CLI session ID
    const record = await sessionChainStore.getByCliSessionId(cliSessionId);
    if (!record) {
      reply.status(404);
      return { error: 'No session found for this CLI session ID' };
    }

    if (record.status !== 'active') {
      reply.status(409);
      return {
        error: `Session already ${record.status}`,
        sessionId: record.id,
        status: record.status,
      };
    }

    // #1329: the hook consumes the policy snapshot owned by this managed
    // invocation. A config read here would let a mid-invocation settings edit
    // change the action family and would re-introduce the policy/capability bug.
    const policy = record.appliedPolicy;
    if (!policy) {
      return reply.send({
        action: 'no_action',
        sessionId: record.id,
        compressionCount: record.compressionCount,
        executionStatus: {
          status: 'unavailable',
          missingCapabilities: ['managed_invocation_boundary'],
        },
        contextEpoch: {
          status: 'unsupported',
          reason: 'managed_invocation_boundary_unavailable',
        },
      });
    }

    // Atomically update lifetime telemetry (when its origin is known) and the
    // revision-scoped hybrid counter. A concurrent policy revision makes the
    // event stale instead of attributing it to the new epoch.
    const observed = await sessionChainStore.recordCompressionEvent(
      record.id,
      policy.revision,
      invocation.invocationId,
    );
    if (!observed) {
      reply.status(409);
      return { error: 'Session disappeared during compression observation (race)', sessionId: record.id };
    }
    const updated = await sessionChainStore.get(record.id);
    const contextEpoch = updated
      ? await compactionSurface.observeAuthoritativeCompaction(updated, 'claude_precompact_hook')
      : { status: 'unsupported' as const, reason: 'session_record_unavailable' as const };

    if (!observed.revisionMatched) {
      return reply.send({
        action: 'no_action',
        reason: 'stale_policy_revision',
        sessionId: record.id,
        compressionCount: observed.compressionCount,
        strategy: policy.config.strategy,
        policyRevision: policy.revision,
        ...(updated?.appliedPolicy ? { activePolicyRevision: updated.appliedPolicy.revision } : {}),
        contextEpoch,
      });
    }

    const strategy = policy.config;
    const canExecuteHandoff = policy.execution.status === 'active';
    const maxCompressions = strategy.hybrid?.maxCompressions ?? 2;
    const hybridCount = observed.hybridProgress?.observedCount ?? null;
    // PreCompact arrives before the pending compaction and the store records
    // that signal atomically before this decision. Count N is therefore the
    // Nth compaction to allow; only signal N+1 exhausts an N-compaction policy.
    const hybridShouldSeal =
      strategy.strategy === 'hybrid' && canExecuteHandoff && hybridCount !== null && hybridCount > maxCompressions;

    if (strategy.strategy === 'compress' || strategy.strategy === 'hybrid' || !canExecuteHandoff) {
      if (!hybridShouldSeal) {
        return reply.send({
          action: canExecuteHandoff || strategy.strategy === 'compress' ? 'compress_allowed' : 'no_action',
          sessionId: record.id,
          compressionCount: observed.compressionCount,
          hybridProgress: observed.hybridProgress,
          ...(strategy.strategy === 'hybrid' ? { maxCompressions } : {}),
          strategy: strategy.strategy,
          executionStatus: policy.execution,
          ...(updated ? { continuity: compactionSurface.compactContinuityFor(updated) } : {}),
          contextEpoch,
        });
      }
    }

    // Hybrid only crosses into handoff after its active, revision-scoped count
    // is exhausted. Degraded hybrid always stays in its own action family.
    const sealReason = strategy.strategy === 'hybrid' ? 'max_compressions' : reason;

    const sealResult = await sessionSealer.requestSeal({
      sessionId: record.id,
      reason: sealReason,
      expectedPolicyRevision: policy.revision,
    });

    if (!sealResult.accepted) {
      if (sealResult.rejectionReason === 'policy_revision_mismatch') {
        const active = await sessionChainStore.get(record.id);
        return reply.send({
          action: 'no_action',
          reason: 'stale_policy_revision',
          sessionId: record.id,
          compressionCount: observed.compressionCount,
          strategy: policy.config.strategy,
          policyRevision: policy.revision,
          ...(active?.appliedPolicy ? { activePolicyRevision: active.appliedPolicy.revision } : {}),
        });
      }
      reply.status(409);
      return {
        error: 'Seal request not accepted (race condition)',
        sessionId: record.id,
        status: sealResult.status,
      };
    }

    // Slow path: async transcript flush (fire-and-forget)
    sessionSealer.finalize({ sessionId: record.id }).catch(() => {
      /* best-effort: finalize failure logged internally */
    });

    return reply.send({
      sessionId: record.id,
      threadId: record.threadId,
      catId: record.catId,
      status: 'sealing',
      strategy: strategy.strategy,
      executionStatus: policy.execution,
      contextEpoch,
    });
  });

  compactionSurface.registerLatestDigestRoute(app);

  // --- F073 P4: SOP stage bookmark ---
  // In-memory store (process-scoped). Replaces /tmp/ file bookmark for AC-14.
  // Survives hook calls within same process; resets on restart (acceptable: bookmark
  // is best-effort context recovery, not critical state).
  const sopBookmarks = new Map<string, { skill: string; sopStage: string; recordedAt: string }>();

  // POST /api/sessions/sop-bookmark — Store SOP stage bookmark
  // Called by sop-stage-bookmark.sh hook on every Skill tool use.
  app.post('/api/sessions/sop-bookmark', async (request, reply) => {
    const parsed = sopBookmarkSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { cliSessionId, skill, sopStage } = parsed.data;
    if (!(await sessionChainStore.getByCliSessionId(cliSessionId))) {
      reply.status(404);
      return { error: 'No session found for this CLI session ID' };
    }
    const now = new Date(Date.now()).toISOString();
    sopBookmarks.set(cliSessionId, { skill, sopStage, recordedAt: now });

    // TTL sweep: remove entries older than 24h (best-effort, runs on each write)
    const ttlMs = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    for (const [key, val] of sopBookmarks) {
      if (new Date(val.recordedAt).getTime() < cutoff) {
        sopBookmarks.delete(key);
      }
    }

    return { ok: true };
  });

  // GET /api/sessions/sop-bookmark — Read SOP stage bookmark
  // Called by f24-post-compact-bootstrap.sh to inject SOP stage after compression.
  app.get<{ Querystring: { cliSessionId?: string } }>('/api/sessions/sop-bookmark', async (request, reply) => {
    const { cliSessionId } = request.query;
    if (!cliSessionId) {
      reply.status(400);
      return { error: 'cliSessionId query parameter required' };
    }
    if (!(await sessionChainStore.getByCliSessionId(cliSessionId))) {
      reply.status(404);
      return { error: 'No session found for this CLI session ID' };
    }
    const bookmark = sopBookmarks.get(cliSessionId);
    if (!bookmark) {
      reply.status(404);
      return { error: 'No SOP bookmark found for this session' };
    }
    return bookmark;
  });
}
