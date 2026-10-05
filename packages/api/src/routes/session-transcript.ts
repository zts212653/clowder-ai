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
import { formatEventsChat } from '../domains/cats/services/session/TranscriptFormatter.js';
import {
  canReadThreadRecord,
  filterThreadRecords,
  resolveThreadAccess,
  threadAccessDeniedBody,
  threadRecordAccessDeniedBody,
} from '../domains/cats/services/session/thread-access-policy.js';
import { TranscriptInvocationReader } from '../domains/cats/services/session/transcript-index/TranscriptInvocationReader.js';
import { resolveUserId } from '../utils/request-identity.js';
import { registerInvocationTrajectoryRoutes } from './invocation-trajectory-routes.js';
import {
  projectHandoffTranscriptPage,
  projectRawTranscriptPage,
  sliceTranscriptEvent,
} from './session-transcript-response.js';
import {
  checkTranscriptCatAccess,
  strictParseTranscriptInteger,
  transcriptSearchSchema,
  VALID_TRANSCRIPT_VIEWS,
} from './session-transcript-route-helpers.js';
import type { ReadableSession, SessionTranscriptRouteOptions } from './session-transcript-route-types.js';
import { withTranscriptReadSignal } from './transcript-read-cancellation.js';

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
    profileRepository,
    memoryCueSourceReader,
  } = opts;

  const invocationReader = new TranscriptInvocationReader(transcriptReader, transcriptWriter);
  async function readInvocationEvents(sessions: ReadableSession[], invocationId: string, signal?: AbortSignal) {
    const pages = await invocationReader.readInvocation(sessions, invocationId, {}, signal);
    return new Map([...pages].map(([id, page]) => [id, page.events]));
  }

  registerInvocationTrajectoryRoutes(app, {
    stores: { invocationRecordStore, turnExecutionStore, sessionChainStore, threadStore },
    listInvocationSummaries: invocationReader.list.bind(invocationReader),
    readInvocationEvents,
    ...(messageStore ? { messageStore } : {}),
    ...(transcriptWriter ? { keyedContentDigest: transcriptWriter.keyedContentDigest.bind(transcriptWriter) } : {}),
    ...(profileRepository ? { profileRepository } : {}),
    ...(memoryCueSourceReader ? { memoryCueSourceReader } : {}),
  });

  // GET /api/sessions/:sessionId/events — Paginated event read (F98: view modes)
  app.get<{
    Params: { sessionId: string };
    Querystring: { cursor?: string; limit?: string; view?: string; charOffset?: string };
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

    const charOffsetParam = request.query.charOffset;
    const charOffset = charOffsetParam === undefined ? undefined : strictParseTranscriptInteger(charOffsetParam);
    if (charOffset !== undefined) {
      if (Number.isNaN(charOffset) || charOffset < 0 || view !== 'raw' || cursorNum === undefined || limit !== 1) {
        reply.status(400);
        return { error: 'charOffset requires raw view, exact cursor eventNo and limit=1' };
      }
      const one = await transcriptReader.readEvents(
        sessionId,
        session.threadId,
        session.catId,
        { eventNo: cursorNum },
        1,
      );
      const event = one.events.find((candidate) => candidate.eventNo === cursorNum);
      if (!event) return reply.status(404).send({ error: 'Event not found' });
      const eventChars = JSON.stringify(event.event).length;
      if (charOffset >= eventChars) {
        reply.status(400);
        return { error: 'charOffset is beyond this event' };
      }
      return reply.send(sliceTranscriptEvent(event, charOffset));
    }

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
      return reply.send(projectHandoffTranscriptPage(handoffResult, sessionId));
    }

    // Raw and chat views: paginate by raw event number
    const cursor = cursorNum != null ? { eventNo: cursorNum } : undefined;
    const result = await transcriptReader.readEvents(sessionId, session.threadId, session.catId, cursor, limit);

    if (view === 'chat') {
      const boundedRaw = projectRawTranscriptPage(result, sessionId);
      const originalByEventNo = new Map(result.events.map((event) => [event.eventNo, event]));
      const messages: Array<Record<string, unknown>> = [];
      for (const event of boundedRaw.events) {
        const original = originalByEventNo.get(event.eventNo);
        if (!original) continue;
        const [message] = formatEventsChat([original]);
        if (!message) continue;
        messages.push(
          'oversized' in event && event.oversized
            ? {
                eventNo: event.eventNo,
                role: message.role,
                oversized: true,
                contentLength: message.content.length,
                drillDown: event.drillDown,
              }
            : { ...message, eventNo: event.eventNo },
        );
      }
      return reply.send({
        messages,
        ...(boundedRaw.nextCursor ? { nextCursor: boundedRaw.nextCursor } : {}),
        total: result.total,
      });
    }

    return reply.send(projectRawTranscriptPage(result, sessionId));
  });

  // GET /api/sessions/:sessionId/digest — Extractive digest
  app.get<{
    Params: { sessionId: string };
    Querystring: { charOffset?: string };
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

    const serialized = JSON.stringify(digest);
    if (request.query.charOffset !== undefined) {
      const charOffset = strictParseTranscriptInteger(request.query.charOffset);
      if (Number.isNaN(charOffset) || charOffset < 0 || charOffset >= serialized.length) {
        return reply.status(400).send({ error: 'Invalid digest charOffset' });
      }
      const digestSlice = serialized.slice(charOffset, charOffset + 8_000);
      const nextCharOffset = charOffset + digestSlice.length;
      return reply.send({
        digestSlice,
        charOffset,
        totalChars: serialized.length,
        ...(nextCharOffset < serialized.length ? { nextCharOffset } : {}),
      });
    }

    if (serialized.length > 24_000) {
      return reply.send({
        oversized: true,
        digestChars: serialized.length,
        drillDown: { tool: 'cat_cafe_read_session_digest', args: { sessionId, charOffset: 0 } },
      });
    }

    return reply.send(digest);
  });

  // GET /api/sessions/:sessionId/invocations/:invocationId — F98 Gap 2
  app.get<{
    Params: { sessionId: string; invocationId: string };
    Querystring: { cursor?: string; limit?: string };
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

    const paginated = request.query.cursor !== undefined || request.query.limit !== undefined;
    let pageOptions: { cursor?: number; limit?: number } = {};
    if (paginated) {
      const cursor = request.query.cursor === undefined ? 0 : strictParseTranscriptInteger(request.query.cursor);
      const limit = request.query.limit === undefined ? 50 : strictParseTranscriptInteger(request.query.limit);
      if (Number.isNaN(cursor) || cursor < 0 || Number.isNaN(limit) || limit < 1 || limit > 200) {
        return reply.status(400).send({ error: 'Invalid invocation cursor or limit' });
      }
      pageOptions = { cursor, limit };
    }
    const pages = await withTranscriptReadSignal(request, reply, (signal) =>
      invocationReader.readInvocation([session], invocationId, pageOptions, signal),
    );
    const page = pages.get(session.id);
    if (!page || page.total === 0) return reply.status(404).send({ error: 'Invocation not found' });
    const { events } = page;
    if (paginated) {
      return reply.send({
        invocationId,
        ...projectRawTranscriptPage(page, sessionId),
      });
    }

    const summary = page.summary;
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
