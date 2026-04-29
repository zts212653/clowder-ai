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
 * corresponding Cat Cafe SessionRecord via `getByCliSessionId()`.
 */

import type { SessionRecord } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { getSessionStrategy } from '../config/session-strategy.js';
import {
  completeCapsuleForCompact,
  isCollaborationContinuityCapsuleV1,
} from '../domains/cats/services/agents/invocation/CollaborationContinuityCapsule.js';
import type { ISessionSealer } from '../domains/cats/services/session/SessionSealer.js';
import type { TranscriptReader } from '../domains/cats/services/session/TranscriptReader.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';

const sealSchema = z.object({
  cliSessionId: z.string().min(1).max(500),
  reason: z.string().min(1).max(200),
});

const sopBookmarkSchema = z.object({
  cliSessionId: z.string().min(1).max(500),
  skill: z.string().min(1).max(100),
  sopStage: z.string().min(1).max(100),
});

interface SessionHooksRouteOptions extends FastifyPluginOptions {
  sessionChainStore: ISessionChainStore;
  sessionSealer: ISessionSealer;
  transcriptReader: TranscriptReader;
  /** Shared secret for hook authentication. If set, X-Cat-Cafe-Hook-Token header is required. */
  hookToken?: string;
}

export async function sessionHooksRoutes(app: FastifyInstance, opts: SessionHooksRouteOptions): Promise<void> {
  const { sessionChainStore, sessionSealer, transcriptReader, hookToken } = opts;

  function compactContinuityFor(record: SessionRecord) {
    const capsule = completeCapsuleForCompact(record.continuityCapsule, { createdAt: Date.now() });
    if (!capsule) return undefined;
    return {
      capsule,
      diagnostics: {
        source: 'active_session_route_state',
        boundary: 'compact_boundary',
        generated: true,
        threadId: record.threadId,
        catId: record.catId,
        sessionId: record.id,
        compressionCount: record.compressionCount ?? 0,
      },
    };
  }

  // Hook authentication guard — fail-closed: always requires valid token
  app.addHook('onRequest', async (request, reply) => {
    if (!hookToken) {
      reply.status(503);
      reply.send({ error: 'Hook authentication not configured (set CAT_CAFE_HOOK_TOKEN)' });
      return;
    }
    const provided = request.headers['x-cat-cafe-hook-token'];
    if (provided !== hookToken) {
      reply.status(401);
      reply.send({ error: 'Invalid or missing hook token' });
    }
  });

  // POST /api/sessions/seal — Hook-triggered session seal
  // Called by f24-pre-compact.sh before Claude Code context compression.
  app.post('/api/sessions/seal', async (request, reply) => {
    const parseResult = sealSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { cliSessionId, reason } = parseResult.data;

    // Look up Cat Cafe session by CLI session ID
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

    // F33: Strategy-aware seal decision
    const strategy = getSessionStrategy(record.catId as string);

    if (strategy.strategy === 'compress') {
      // compress strategy: never seal from hook, just record the compression event
      // Atomic increment avoids race when concurrent hook calls overlap (P1 fix)
      const newCount = await sessionChainStore.incrementCompressionCount(record.id);
      if (newCount == null) {
        reply.status(409);
        return { error: 'Session disappeared during compression increment (race)', sessionId: record.id };
      }
      const updated = await sessionChainStore.get(record.id);
      return reply.send({
        action: 'compress_allowed',
        sessionId: record.id,
        compressionCount: newCount,
        strategy: 'compress',
        ...(updated ? { continuity: compactContinuityFor(updated) } : {}),
      });
    }

    if (strategy.strategy === 'hybrid') {
      const max = strategy.hybrid?.maxCompressions ?? 2;
      // Atomic increment-then-check: avoids TOCTOU race on concurrent hook calls (P1 fix)
      const newCount = await sessionChainStore.incrementCompressionCount(record.id);
      if (newCount == null) {
        reply.status(409);
        return { error: 'Session disappeared during compression increment (race)', sessionId: record.id };
      }
      if (newCount <= max) {
        const updated = await sessionChainStore.get(record.id);
        return reply.send({
          action: 'compress_allowed',
          sessionId: record.id,
          compressionCount: newCount,
          maxCompressions: max,
          strategy: 'hybrid',
          ...(updated ? { continuity: compactContinuityFor(updated) } : {}),
        });
      }
      // At or over max → seal with max_compressions reason (not the hook's reason)
    }

    // Determine seal reason: hybrid over max → 'max_compressions', otherwise use hook reason
    const sealReason = strategy.strategy === 'hybrid' ? 'max_compressions' : reason;

    const sealResult = await sessionSealer.requestSeal({
      sessionId: record.id,
      reason: sealReason,
    });

    if (!sealResult.accepted) {
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
    });
  });

  // GET /api/sessions/latest-digest — Get the latest sealed session's digest
  // Called by f24-post-compact-bootstrap.sh to inject context after compression.
  app.get<{
    Querystring: { cliSessionId?: string };
  }>('/api/sessions/latest-digest', async (request, reply) => {
    const { cliSessionId } = request.query;
    if (!cliSessionId) {
      reply.status(400);
      return { error: 'cliSessionId query parameter required' };
    }

    // Look up the session record to find catId + threadId
    const record = await sessionChainStore.getByCliSessionId(cliSessionId);
    if (!record) {
      reply.status(404);
      return { error: 'No session found for this CLI session ID' };
    }

    const activeCompactContinuity =
      record.status === 'active' && (record.compressionCount ?? 0) > 0 ? compactContinuityFor(record) : undefined;
    if (activeCompactContinuity) {
      return reply.send({
        sessionId: record.id,
        status: record.status,
        seq: record.seq,
        catId: record.catId,
        threadId: record.threadId,
        digest: null,
        continuity: activeCompactContinuity,
      });
    }

    // Get the full chain for this cat+thread, find the latest sealed session
    const chain = await sessionChainStore.getChain(record.catId, record.threadId);
    const sealedSessions = chain
      .filter((s) => s.status === 'sealed' && s.sealedAt != null)
      .sort((a, b) => (b.sealedAt ?? 0) - (a.sealedAt ?? 0));

    if (sealedSessions.length === 0) {
      reply.status(404);
      return { error: 'No sealed sessions found' };
    }

    const latest = sealedSessions[0]!;

    // Read extractive digest
    const digest = await transcriptReader.readDigest(latest.id, latest.threadId, latest.catId);
    if (!digest) {
      reply.status(404);
      return { error: 'Digest not found for latest sealed session' };
    }
    const sealedCapsule = isCollaborationContinuityCapsuleV1(digest.continuityCapsule)
      ? digest.continuityCapsule
      : undefined;

    return reply.send({
      sessionId: latest.id,
      seq: latest.seq,
      catId: latest.catId,
      threadId: latest.threadId,
      sealedAt: latest.sealedAt,
      digest,
      ...(sealedCapsule
        ? {
            continuity: {
              capsule: sealedCapsule,
              diagnostics: {
                source: 'sealed_session_digest',
                boundary: sealedCapsule.continuationReason,
                generated: true,
                threadId: latest.threadId,
                catId: latest.catId,
                sessionId: latest.id,
              },
            },
          }
        : {}),
    });
  });

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
    const bookmark = sopBookmarks.get(cliSessionId);
    if (!bookmark) {
      reply.status(404);
      return { error: 'No SOP bookmark found for this session' };
    }
    return bookmark;
  });
}
