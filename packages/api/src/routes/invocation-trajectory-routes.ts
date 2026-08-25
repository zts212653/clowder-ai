import type { FastifyInstance } from 'fastify';
import { resolveCanonicalInvocationTrajectory } from '../domains/cats/services/session/CanonicalInvocationTrajectoryResolver.js';
import { projectInvocationTrajectories } from '../domains/cats/services/session/InvocationTrajectoryProjector.js';
import {
  projectRequestGenerationGaps,
  projectRequestGenerations,
} from '../domains/cats/services/session/RequestGenerationProjector.js';
import {
  requestGenerationSourceKey,
  resolveRequestGenerationSourceStates,
} from '../domains/cats/services/session/request-generation-source-policy.js';
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
  stores: Pick<
    SessionTranscriptRouteOptions,
    'invocationRecordStore' | 'turnExecutionStore' | 'sessionChainStore' | 'threadStore'
  >;
  readSessionEvents: (session: ReadableSession) => Promise<TranscriptEvent[]>;
  readInvocationEvents: (session: ReadableSession, invocationId: string) => Promise<TranscriptEvent[]>;
  messageStore?: SessionTranscriptRouteOptions['messageStore'];
  keyedContentDigest?: (value: string) => Promise<string>;
  profileRepository?: SessionTranscriptRouteOptions['profileRepository'];
  memoryCueSourceReader?: SessionTranscriptRouteOptions['memoryCueSourceReader'];
}

export function registerInvocationTrajectoryRoutes(
  app: FastifyInstance,
  dependencies: InvocationTrajectoryRouteDependencies,
): void {
  const { invocationRecordStore, turnExecutionStore, sessionChainStore, threadStore } = dependencies.stores;

  app.get<{
    Params: { invocationId: string };
    Querystring: { threadId?: string; sessionId?: string };
  }>('/api/invocations/:invocationId/trajectory', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required', code: 'IDENTITY_REQUIRED' });
    if (!turnExecutionStore) {
      return reply
        .status(503)
        .send({ error: 'Invocation resolver unavailable', code: 'INVOCATION_RESOLVER_UNAVAILABLE' });
    }
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
        turnExecutionStore,
        sessionChainStore,
        threadStore,
        readInvocationEvents: dependencies.readInvocationEvents,
      },
    );
    return reply.status(result.status).send(result.body);
  });

  app.get<{
    Params: { invocationId: string };
    Querystring: { threadId?: string; sessionId?: string; reveal?: string };
  }>('/api/invocations/:invocationId/request-generations', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required', code: 'IDENTITY_REQUIRED' });
    if (!turnExecutionStore) {
      return reply
        .status(503)
        .send({ error: 'Invocation resolver unavailable', code: 'INVOCATION_RESOLVER_UNAVAILABLE' });
    }
    if (request.query.reveal !== undefined && request.query.reveal !== 'exact') {
      return reply.status(400).send({ error: 'Invalid reveal mode', code: 'INVOCATION_GENERATION_REVEAL_INVALID' });
    }
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
        turnExecutionStore,
        sessionChainStore,
        threadStore,
        readInvocationEvents: dependencies.readInvocationEvents,
      },
    );
    if (result.status !== 200) return reply.status(result.status).send(result.body);
    const sessionIds = result.body.sessionIds ?? [result.body.sessionId];
    const sessions = await Promise.all(sessionIds.map((sessionId) => sessionChainStore.get(sessionId)));
    if (sessions.some((session) => !session)) {
      return reply
        .status(409)
        .send({ error: 'Invocation session chain changed during read', code: 'INVOCATION_SESSION_CHAIN_CHANGED' });
    }
    try {
      const events = (
        await Promise.all(
          sessions.map((session) =>
            dependencies.readInvocationEvents(session as ReadableSession, request.params.invocationId),
          ),
        )
      ).flat();
      const hidden = projectRequestGenerations(events);
      const gaps = projectRequestGenerationGaps(events);
      let generations = hidden;
      if (request.query.reveal === 'exact') {
        const sourceRefs = hidden.flatMap(({ envelope }) => envelope.channels.flatMap((channel) => channel.sourceRefs));
        const states = await resolveRequestGenerationSourceStates(sourceRefs, {
          userId,
          threadId: result.body.threadId,
          invocationId: request.params.invocationId,
          catId: (sessions[0] as ReadableSession).catId,
          ...(dependencies.messageStore ? { messageStore: dependencies.messageStore } : {}),
          threadStore,
          ...(dependencies.keyedContentDigest ? { keyedContentDigest: dependencies.keyedContentDigest } : {}),
          ...(dependencies.profileRepository ? { profileRepository: dependencies.profileRepository } : {}),
          ...(dependencies.memoryCueSourceReader ? { memoryCueSourceReader: dependencies.memoryCueSourceReader } : {}),
        });
        generations = projectRequestGenerations(
          events,
          (sourceRef) => states.get(requestGenerationSourceKey(sourceRef)) ?? 'unknown',
        );
      }
      return reply.send({
        invocationId: request.params.invocationId,
        threadId: result.body.threadId,
        generations,
        gaps,
      });
    } catch {
      return reply.status(409).send({
        error: 'Invocation request-generation evidence is inconsistent',
        code: 'INVOCATION_GENERATION_INTEGRITY_MISMATCH',
      });
    }
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
