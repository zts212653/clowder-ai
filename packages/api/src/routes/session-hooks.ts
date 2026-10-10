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
import { createSealOnPreCompact } from './session-seal-handler.js';

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

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value || undefined;
  return Array.isArray(value) ? value[0] || undefined : undefined;
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
  const sealOnPreCompact = createSealOnPreCompact({ sessionChainStore, sessionSealer, compactionSurface });

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
    // #1542 guard 4: when this invocation launched a managed carrier plan, only
    // that carrier's identity may mint the compression observation — a legacy
    // shell hook firing alongside the canonical Node carrier must never produce
    // a second logical observation. Checked BEFORE recordCompressionEvent. The
    // expectation is durable on the callback principal (survives restarts).
    const expectedCarrier = invocation.expectedCompactionCarrier;
    if (expectedCarrier !== undefined) {
      const presented = firstHeader(request.headers['x-clowder-compaction-carrier']);
      if (presented !== expectedCarrier) {
        reply.status(403);
        return { error: 'compaction_carrier_identity_mismatch' };
      }
    }
    const parseResult = sealSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { cliSessionId, reason } = parseResult.data;
    const outcome = await sealOnPreCompact(invocation.invocationId, cliSessionId, reason);
    reply.status(outcome.status);
    return outcome.body;
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
