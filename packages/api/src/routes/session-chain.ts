/**
 * Session Chain Routes
 * F24: API endpoints for session chain + context health data.
 *
 * GET   /api/threads/:threadId/sessions            - List sessions (optional catId filter)
 * GET   /api/sessions/:sessionId                   - Get single session record
 * POST  /api/sessions/:sessionId/unseal            - Manual unseal fallback (#F062)
 * PATCH /api/threads/:threadId/sessions/:catId/bind - Manual bind CLI session ID (#72)
 */

import { type CatId, catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { backfillBoundSessionHistory } from '../domains/cats/services/session/BoundSessionHistoryImporter.js';
import type { ISessionSealer } from '../domains/cats/services/session/SessionSealer.js';
import type { TranscriptReader } from '../domains/cats/services/session/TranscriptReader.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveUserId } from '../utils/request-identity.js';

const bindSessionSchema = z.object({
  cliSessionId: z.string().min(1).max(500),
});

interface SessionChainRouteOptions extends FastifyPluginOptions {
  sessionChainStore: ISessionChainStore;
  threadStore: IThreadStore;
  messageStore?: IMessageStore;
  transcriptReader?: TranscriptReader;
  sessionSealer?: ISessionSealer;
}

export async function sessionChainRoutes(app: FastifyInstance, opts: SessionChainRouteOptions): Promise<void> {
  const { sessionChainStore, threadStore, messageStore, transcriptReader, sessionSealer } = opts;

  app.get<{
    Params: { threadId: string };
    Querystring: { catId?: string };
  }>('/api/threads/:threadId/sessions', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const { threadId } = request.params;
    const thread = await threadStore.get(threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const { catId } = request.query;
    const callerCatId = request.headers['x-cat-id'] as string | undefined;

    // When caller identifies as a specific cat (MCP tool), restrict to own sessions only.
    // Query param `catId` is ignored when it differs from caller — prevents cross-cat enumeration.
    const effectiveCatId = callerCatId ?? catId;

    if (effectiveCatId) {
      if (callerCatId && catId && catId !== callerCatId) {
        reply.status(403);
        return { error: `Cannot query sessions for cat '${catId}' — you are '${callerCatId}'` };
      }
      const sessions = await sessionChainStore.getChain(effectiveCatId as CatId, threadId);
      return reply.send({ sessions });
    }

    // No catId filter at all (hub UI god-view) — return all sessions for the thread
    const sessions = await sessionChainStore.getChainByThread(threadId);
    return reply.send({ sessions });
  });

  app.get<{
    Params: { sessionId: string };
  }>('/api/sessions/:sessionId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const { sessionId } = request.params;
    const session = await sessionChainStore.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // Verify thread ownership via session -> thread
    const thread = await threadStore.get(session.threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }
    if (thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    return reply.send(session);
  });

  // POST /api/sessions/:sessionId/unseal — Manual fallback (#F062)
  // Re-open a sealed/sealing session by creating a fresh active chain record
  // bound to the same CLI session ID.
  app.post<{
    Params: { sessionId: string };
  }>('/api/sessions/:sessionId/unseal', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const { sessionId } = request.params;
    const session = await sessionChainStore.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const thread = await threadStore.get(session.threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }
    if (thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    if (session.status === 'active') {
      return reply.send({ session, mode: 'already_active' as const });
    }
    if (session.status !== 'sealed' && session.status !== 'sealing') {
      reply.status(409);
      return { error: `Session status ${session.status} cannot be reopened` };
    }

    const active = await sessionChainStore.getActive(session.catId, session.threadId);
    if (active && active.id !== session.id) {
      // Only displace the active session if it's empty (no messages).
      // A non-empty active session is real work — refuse to destroy it.
      if ((active.messageCount ?? 0) > 0) {
        reply.status(409);
        return {
          error: 'Another active session with messages already exists for this cat/thread',
          activeSessionId: active.id,
        };
      }
      // Empty replacement (e.g., auto-seal created it) → safe to displace.
      // Use sessionSealer when available for consistent seal semantics.
      let displaced = false;
      if (sessionSealer) {
        try {
          const result = await sessionSealer.requestSeal({ sessionId: active.id, reason: 'unseal_displacement' });
          if (result.accepted) {
            sessionSealer.finalize({ sessionId: active.id }).catch(() => {});
            displaced = true;
          }
        } catch {
          /* best-effort — empty session, no data to lose */
        }
      } else {
        await sessionChainStore.update(active.id, {
          status: 'sealed',
          sealReason: 'unseal_displacement',
          sealedAt: Date.now(),
          updatedAt: Date.now(),
        });
        displaced = true;
      }
      if (!displaced) {
        reply.status(409);
        return {
          error: 'Failed to displace active session (CAS race) — retry unseal',
          activeSessionId: active.id,
        };
      }
    }

    const reopened = await sessionChainStore.create({
      cliSessionId: session.cliSessionId,
      threadId: session.threadId,
      catId: session.catId,
      userId: session.userId,
    });

    getEventAuditLog()
      .append({
        type: AuditEventTypes.SESSION_BIND,
        threadId: session.threadId,
        data: {
          mode: 'unseal_reopen',
          fromSessionId: session.id,
          toSessionId: reopened.id,
          catId: session.catId,
          cliSessionId: session.cliSessionId,
          userId,
        },
      })
      .catch(() => {
        /* best-effort */
      });

    return reply.send({
      mode: 'reopened' as const,
      fromSessionId: session.id,
      session: reopened,
    });
  });

  // PATCH /api/threads/:threadId/sessions/:catId/bind — Manual bind (#72)
  // Allows 铲屎官 to bind a known-good CLI session ID to a cat's thread session.
  // If active session exists → update cliSessionId; otherwise → create new session.
  app.patch<{
    Params: { threadId: string; catId: string };
  }>('/api/threads/:threadId/sessions/:catId/bind', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const { threadId, catId } = request.params;

    // Validate catId against runtime registry
    if (!catRegistry.has(catId)) {
      reply.status(400);
      return { error: `Invalid catId: ${catId}. Must be one of: ${catRegistry.getAllIds().join(', ')}` };
    }

    // Validate body
    const parseResult = bindSessionSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { cliSessionId } = parseResult.data;

    // Verify thread exists + ownership
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }
    if (thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    // Check for active session
    const active = await sessionChainStore.getActive(catId as CatId, threadId);

    let session;
    let mode: 'updated' | 'created';

    if (active) {
      // Update existing active session's cliSessionId
      const updated = await sessionChainStore.update(active.id, {
        cliSessionId,
        updatedAt: Date.now(),
      });
      if (!updated) {
        reply.status(409);
        return { error: 'Session was modified concurrently, please retry' };
      }
      session = updated;
      mode = 'updated';
    } else {
      // No active session → create new one
      session = await sessionChainStore.create({
        cliSessionId,
        threadId,
        catId: catId as CatId,
        userId,
      });
      mode = 'created';
    }

    // Audit trail (best-effort, fire-and-forget)
    getEventAuditLog()
      .append({
        type: AuditEventTypes.SESSION_BIND,
        threadId,
        data: { catId, cliSessionId, mode, sessionId: session.id, userId },
      })
      .catch(() => {
        /* best-effort */
      });

    const historyImport = await backfillBoundSessionHistory({
      sessionChainStore,
      transcriptReader,
      messageStore,
      threadId,
      catId: catId as CatId,
      userId,
    });

    return reply.send({ session, mode, historyImport });
  });
}
