/**
 * Session Transcript Routes — F24 Phase D + F98
 * API endpoints for reading sealed session transcripts.
 *
 * GET  /api/sessions/:sessionId/events                    — Paginated events (view=raw|chat|handoff)
 * GET  /api/sessions/:sessionId/digest                    — Extractive digest
 * GET  /api/sessions/:sessionId/invocations/:invocationId — Events for one invocation
 * GET  /api/threads/:threadId/sessions/search              — Full-text search
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { formatEventsChat, formatEventsHandoff } from '../domains/cats/services/session/TranscriptFormatter.js';
import type { TranscriptReader } from '../domains/cats/services/session/TranscriptReader.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveUserId } from '../utils/request-identity.js';

const VALID_VIEWS = new Set(['raw', 'chat', 'handoff']);

interface SessionTranscriptRouteOptions extends FastifyPluginOptions {
  sessionChainStore: ISessionChainStore;
  threadStore: IThreadStore;
  transcriptReader: TranscriptReader;
}

/** Strict integer parse: only pure decimal digit strings (no whitespace, no partial) */
function strictParseInt(s: string): number {
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

const searchSchema = z.object({
  q: z.string().min(1).max(500),
  cats: z.string().optional(),
  sessionIds: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  scope: z.enum(['digests', 'transcripts', 'both']).optional(),
});

function checkCatIdAccess(request: { headers: Record<string, unknown> }, sessionCatId: string): string | null {
  const callerCatId = request.headers['x-cat-id'] as string | undefined;
  if (callerCatId && sessionCatId !== callerCatId) {
    return 'Access denied: session belongs to a different cat';
  }
  return null;
}

export async function sessionTranscriptRoutes(
  app: FastifyInstance,
  opts: SessionTranscriptRouteOptions,
): Promise<void> {
  const { sessionChainStore, threadStore, transcriptReader } = opts;

  // GET /api/sessions/:sessionId/events — Paginated event read (F98: view modes)
  app.get<{
    Params: { sessionId: string };
    Querystring: { cursor?: string; limit?: string; view?: string };
  }>('/api/sessions/:sessionId/events', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { sessionId } = request.params;
    const session = await sessionChainStore.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const thread = await threadStore.get(session.threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const callerCatIdErr = checkCatIdAccess(request, session.catId);
    if (callerCatIdErr) {
      reply.status(403);
      return { error: callerCatIdErr };
    }

    const view = (request.query.view ?? 'raw') as string;
    if (!VALID_VIEWS.has(view)) {
      reply.status(400);
      return { error: `Invalid view: must be one of raw, chat, handoff` };
    }

    const cursorParam = request.query.cursor;
    const cursorNum = cursorParam ? strictParseInt(cursorParam) : undefined;
    if (cursorNum != null && (Number.isNaN(cursorNum) || cursorNum < 0)) {
      reply.status(400);
      return { error: 'Invalid cursor: must be a non-negative integer' };
    }
    const cursor = cursorNum != null ? { eventNo: cursorNum } : undefined;

    const limitParam = request.query.limit;
    const limitNum = limitParam ? strictParseInt(limitParam) : undefined;
    if (limitNum != null && (Number.isNaN(limitNum) || limitNum < 1)) {
      reply.status(400);
      return { error: 'Invalid limit: must be a positive integer' };
    }
    const limit = limitNum != null ? Math.min(limitNum, 200) : 50;

    const result = await transcriptReader.readEvents(sessionId, session.threadId, session.catId, cursor, limit);

    if (view === 'chat') {
      return reply.send({
        messages: formatEventsChat(result.events),
        nextCursor: result.nextCursor,
        total: result.total,
      });
    }
    if (view === 'handoff') {
      return reply.send({
        invocations: formatEventsHandoff(result.events),
        nextCursor: result.nextCursor,
        total: result.total,
      });
    }

    return reply.send(result);
  });

  // GET /api/sessions/:sessionId/digest — Extractive digest
  app.get<{
    Params: { sessionId: string };
  }>('/api/sessions/:sessionId/digest', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { sessionId } = request.params;
    const session = await sessionChainStore.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const thread = await threadStore.get(session.threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const callerCatIdErr2 = checkCatIdAccess(request, session.catId);
    if (callerCatIdErr2) {
      reply.status(403);
      return { error: callerCatIdErr2 };
    }

    const digest = await transcriptReader.readDigest(sessionId, session.threadId, session.catId);
    if (!digest) {
      return reply.status(404).send({ error: 'Digest not found' });
    }

    return reply.send(digest);
  });

  // GET /api/sessions/:sessionId/invocations/:invocationId — F98 Gap 2
  app.get<{
    Params: { sessionId: string; invocationId: string };
  }>('/api/sessions/:sessionId/invocations/:invocationId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { sessionId, invocationId } = request.params;
    const session = await sessionChainStore.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const thread = await threadStore.get(session.threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const callerCatIdErr3 = checkCatIdAccess(request, session.catId);
    if (callerCatIdErr3) {
      reply.status(403);
      return { error: callerCatIdErr3 };
    }

    const events = await transcriptReader.readInvocationEvents(
      sessionId,
      session.threadId,
      session.catId,
      invocationId,
    );
    if (!events) {
      return reply.status(404).send({ error: 'Invocation not found' });
    }

    return reply.send({ invocationId, events, total: events.length });
  });

  // GET /api/threads/:threadId/sessions/search — Full-text search
  app.get<{
    Params: { threadId: string };
    Querystring: Record<string, string>;
  }>('/api/threads/:threadId/sessions/search', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { threadId } = request.params;
    const thread = await threadStore.get(threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const parseResult = searchSchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parseResult.error.issues };
    }

    const { q, cats, sessionIds, limit, scope } = parseResult.data;

    // P0a enforcement: when x-cat-id header is present, force-filter to caller's own sessions only
    // Prevents game-playing cats from searching other cats' session content (KD-39)
    const callerCatId = request.headers['x-cat-id'] as string | undefined;
    const catsArr = callerCatId ? [callerCatId] : cats?.split(',').filter(Boolean);
    const sessionIdsArr = sessionIds?.split(',').filter(Boolean);

    const hits = await transcriptReader.search(threadId, q, {
      ...(catsArr ? { cats: catsArr } : {}),
      ...(sessionIdsArr ? { sessionIds: sessionIdsArr } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(scope ? { scope } : {}),
    });

    return reply.send({ hits });
  });
}
