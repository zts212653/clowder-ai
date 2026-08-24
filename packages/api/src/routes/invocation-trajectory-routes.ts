import type { FastifyInstance } from 'fastify';
import { resolveCanonicalInvocationTrajectory } from '../domains/cats/services/session/CanonicalInvocationTrajectoryResolver.js';
import { projectInvocationTrajectories } from '../domains/cats/services/session/InvocationTrajectoryProjector.js';
import type { TranscriptEvent } from '../domains/cats/services/session/TranscriptReader.js';
import {
  filterThreadRecords,
  resolveThreadAccess,
  threadAccessDeniedBody,
} from '../domains/cats/services/session/thread-access-policy.js';
import { resolveUserId } from '../utils/request-identity.js';
import { strictParseTranscriptInteger } from './session-transcript-route-helpers.js';
import type { ReadableSession, SessionTranscriptRouteOptions } from './session-transcript-route-types.js';

interface InvocationTrajectoryRouteDependencies {
  stores: Pick<SessionTranscriptRouteOptions, 'invocationRecordStore' | 'sessionChainStore' | 'threadStore'>;
  readSessionEvents: (session: ReadableSession) => Promise<TranscriptEvent[]>;
  readInvocationEvents: (session: ReadableSession, invocationId: string) => Promise<TranscriptEvent[]>;
}

export function registerInvocationTrajectoryRoutes(
  app: FastifyInstance,
  dependencies: InvocationTrajectoryRouteDependencies,
): void {
  const { invocationRecordStore, sessionChainStore, threadStore } = dependencies.stores;

  app.get<{
    Params: { invocationId: string };
    Querystring: { threadId?: string; sessionId?: string };
  }>('/api/invocations/:invocationId/trajectory', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required', code: 'IDENTITY_REQUIRED' });
    const result = await resolveCanonicalInvocationTrajectory(
      {
        invocationId: request.params.invocationId,
        userId,
        threadIdHint: request.query.threadId,
        sessionIdHint: request.query.sessionId,
        callerCatId: request.headers['x-cat-id'] as string | undefined,
      },
      {
        invocationRecordStore,
        sessionChainStore,
        threadStore,
        readInvocationEvents: dependencies.readInvocationEvents,
      },
    );
    return reply.status(result.status).send(result.body);
  });

  app.get<{
    Params: { threadId: string };
    Querystring: { limit?: string };
  }>('/api/threads/:threadId/invocations', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const thread = await threadStore.get(request.params.threadId);
    if (!thread) return reply.status(404).send({ error: 'Thread not found' });
    const access = await resolveThreadAccess({
      threadStore,
      thread,
      userId,
      request: { resource: 'invocations', action: 'read' },
    });
    if (access.status === 403) return reply.status(403).send(threadAccessDeniedBody(access));
    const visibleSessions = filterThreadRecords(
      access,
      await sessionChainStore.getChainByThread(request.params.threadId),
    );
    const callerCatId = request.headers['x-cat-id'] as string | undefined;
    const scopedSessions = callerCatId
      ? visibleSessions.filter((session) => session.catId === callerCatId)
      : visibleSessions;
    const limitValue = request.query.limit === undefined ? 200 : strictParseTranscriptInteger(request.query.limit);
    if (Number.isNaN(limitValue) || limitValue < 1) {
      return reply.status(400).send({ error: 'Invalid limit: must be a positive integer' });
    }
    const projected = (
      await Promise.all(
        scopedSessions.map(async (session) =>
          projectInvocationTrajectories(await dependencies.readSessionEvents(session), session),
        ),
      )
    )
      .flat()
      .sort((left, right) => right.startedAt - left.startedAt || left.invocationId.localeCompare(right.invocationId));
    return reply.send({
      invocations: projected.slice(0, Math.min(limitValue, 500)),
      total: projected.length,
    });
  });
}
