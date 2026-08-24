/**
 * Session Transcript Routes — F24 Phase D + F98
 * API endpoints for reading active and sealed session transcripts.
 *
 * GET  /api/sessions/:sessionId/events                    — Paginated events (view=raw|chat|handoff)
 * GET  /api/sessions/:sessionId/digest                    — Extractive digest
 * GET  /api/sessions/:sessionId/invocations/:invocationId — Events for one invocation
 * GET  /api/threads/:threadId/sessions/search              — Full-text search
 */

import type { FastifyInstance } from 'fastify';
import { projectInvocationPromptInput } from '../domains/cats/services/session/InvocationPromptInputProjector.js';
import { projectInvocationTrajectories } from '../domains/cats/services/session/InvocationTrajectoryProjector.js';
import { mergeTranscriptEventSources } from '../domains/cats/services/session/TranscriptEventEnvelope.js';
import { formatEventsChat } from '../domains/cats/services/session/TranscriptFormatter.js';
import {
  canReadThreadRecord,
  filterThreadRecords,
  resolveThreadAccess,
  threadAccessDeniedBody,
  threadRecordAccessDeniedBody,
} from '../domains/cats/services/session/thread-access-policy.js';
import { resolveUserId } from '../utils/request-identity.js';
import { registerInvocationTrajectoryRoutes } from './invocation-trajectory-routes.js';
import {
  checkTranscriptCatAccess,
  strictParseTranscriptInteger,
  transcriptSearchSchema,
  VALID_TRANSCRIPT_VIEWS,
} from './session-transcript-route-helpers.js';
import type { ReadableSession, SessionTranscriptRouteOptions } from './session-transcript-route-types.js';

export async function sessionTranscriptRoutes(
  app: FastifyInstance,
  opts: SessionTranscriptRouteOptions,
): Promise<void> {
  const {
    invocationRecordStore,
    sessionChainStore,
    threadStore,
    transcriptReader,
    transcriptWriter,
    messageStore,
    turnExecutionStore,
  } = opts;

  async function readActiveSessionEvents(session: ReadableSession) {
    if (session.status !== 'sealed' && transcriptWriter) {
      return transcriptWriter.readActiveEvents({
        sessionId: session.id,
        threadId: session.threadId,
        catId: session.catId,
        ...(session.cliSessionId ? { cliSessionId: session.cliSessionId } : {}),
        seq: session.seq,
      });
    }
    return [];
  }

  async function readSessionEvents(session: ReadableSession) {
    const activeEvents = await readActiveSessionEvents(session);
    const persistedEvents = await transcriptReader.readAllEvents(session.id, session.threadId, session.catId);
    return mergeTranscriptEventSources(persistedEvents, activeEvents);
  }

  async function readInvocationEvents(session: ReadableSession, invocationId: string) {
    return (await readSessionEvents(session)).filter((event) => event.invocationId === invocationId);
  }

  registerInvocationTrajectoryRoutes(app, {
    stores: { invocationRecordStore, sessionChainStore, threadStore },
    readSessionEvents,
    readInvocationEvents,
  });

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
    const access = await resolveThreadAccess({
      threadStore,
      thread,
      userId,
      request: { resource: 'transcript', action: 'read' },
    });
    if (access.status === 403) {
      return reply.status(403).send(threadAccessDeniedBody(access));
    }
    if (!canReadThreadRecord(access, session)) {
      return reply.status(403).send(threadRecordAccessDeniedBody());
    }

    const callerCatIdErr = checkTranscriptCatAccess(request, session.catId);
    if (callerCatIdErr) {
      reply.status(403);
      return { error: callerCatIdErr };
    }

    const view = (request.query.view ?? 'raw') as string;
    if (!VALID_TRANSCRIPT_VIEWS.has(view)) {
      reply.status(400);
      return { error: `Invalid view: must be one of raw, chat, handoff` };
    }

    const cursorParam = request.query.cursor;
    const cursorNum = cursorParam ? strictParseTranscriptInteger(cursorParam) : undefined;
    if (cursorNum != null && (Number.isNaN(cursorNum) || cursorNum < 0)) {
      reply.status(400);
      return { error: 'Invalid cursor: must be a non-negative integer' };
    }

    const limitParam = request.query.limit;
    const limitNum = limitParam ? strictParseTranscriptInteger(limitParam) : undefined;
    if (limitNum != null && (Number.isNaN(limitNum) || limitNum < 1)) {
      reply.status(400);
      return { error: 'Invalid limit: must be a positive integer' };
    }
    const limit = limitNum != null ? Math.min(limitNum, 200) : 50;

    // Handoff view: read all events, group into complete invocation summaries,
    // paginate by raw-event budget. The cursor is a genuine raw eventNo —
    // same semantics as raw/chat views — preserving the external API contract.
    if (view === 'handoff') {
      const handoffCursor = cursorNum != null ? { eventNo: cursorNum } : undefined;
      const handoffResult = await transcriptReader.readEventsHandoff(
        sessionId,
        session.threadId,
        session.catId,
        handoffCursor,
        limit,
      );
      return reply.send({
        invocations: handoffResult.invocations,
        ...(handoffResult.nextCursor ? { nextCursor: handoffResult.nextCursor } : {}),
        total: handoffResult.total,
      });
    }

    // Raw and chat views: paginate by raw event number
    const cursor = cursorNum != null ? { eventNo: cursorNum } : undefined;
    const result = await transcriptReader.readEvents(sessionId, session.threadId, session.catId, cursor, limit);

    if (view === 'chat') {
      return reply.send({
        messages: formatEventsChat(result.events),
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
    const access = await resolveThreadAccess({
      threadStore,
      thread,
      userId,
      request: { resource: 'transcript', action: 'read' },
    });
    if (access.status === 403) {
      return reply.status(403).send(threadAccessDeniedBody(access));
    }
    if (!canReadThreadRecord(access, session)) {
      return reply.status(403).send(threadRecordAccessDeniedBody());
    }

    const callerCatIdErr2 = checkTranscriptCatAccess(request, session.catId);
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
    const access = await resolveThreadAccess({
      threadStore,
      thread,
      userId,
      request: { resource: 'invocations', action: 'read' },
    });
    if (access.status === 403) {
      return reply.status(403).send(threadAccessDeniedBody(access));
    }
    if (!canReadThreadRecord(access, session)) {
      return reply.status(403).send(threadRecordAccessDeniedBody());
    }

    const callerCatIdErr3 = checkTranscriptCatAccess(request, session.catId);
    if (callerCatIdErr3) {
      reply.status(403);
      return { error: callerCatIdErr3 };
    }

    const events = await readInvocationEvents(session, invocationId);
    if (events.length === 0) return reply.status(404).send({ error: 'Invocation not found' });

    const summary = projectInvocationTrajectories(events, session)[0];
    const promptInput = await projectInvocationPromptInput(
      { messageStore, turnExecutionStore },
      session,
      invocationId,
      userId,
    );
    return reply.send({ invocationId, events, total: events.length, summary, promptInput });
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
    const access = await resolveThreadAccess({
      threadStore,
      thread,
      userId,
      request: { resource: 'transcript', action: 'search' },
    });
    if (access.status === 403) {
      return reply.status(403).send(threadAccessDeniedBody(access));
    }

    const parseResult = transcriptSearchSchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parseResult.error.issues };
    }

    const { q, cats, sessionIds, limit, scope } = parseResult.data;

    // P0a enforcement: when x-cat-id header is present, force-filter to caller's own sessions only
    // Prevents game-playing cats from searching other cats' session content (KD-39)
    const callerCatId = request.headers['x-cat-id'] as string | undefined;
    const catsArr = callerCatId ? [callerCatId] : cats?.split(',').filter(Boolean);
    const requestedSessionIds = sessionIds?.split(',').filter(Boolean);
    const accessibleSessions = filterThreadRecords(access, await sessionChainStore.getChainByThread(threadId));
    const accessibleSessionIds = new Set(accessibleSessions.map((session) => session.id));
    const sessionIdsArr = requestedSessionIds
      ? requestedSessionIds.filter((sessionId) => accessibleSessionIds.has(sessionId))
      : access.scope === 'user'
        ? [...accessibleSessionIds]
        : undefined;

    const hits = await transcriptReader.search(threadId, q, {
      ...(catsArr ? { cats: catsArr } : {}),
      ...(sessionIdsArr ? { sessionIds: sessionIdsArr } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(scope ? { scope } : {}),
    });

    return reply.send({ hits });
  });
}
