import { randomUUID } from 'node:crypto';
import type { CatId, SessionRecord } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentRegistry } from '../domains/cats/services/agents/registry/AgentRegistry.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ProviderNativeStatus } from '../domains/cats/services/types.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

interface NativeThreadStatusRouteOptions extends FastifyPluginOptions {
  readonly agentRegistry: AgentRegistry;
  readonly sessionChainStore: ISessionChainStore;
  readonly threadStore: IThreadStore;
}

interface ThreadParams {
  Params: { threadId: string };
}

interface ForkParams extends ThreadParams {
  Params: { threadId: string; catId: string };
  Body: { targetThreadId?: string };
}

interface ThreadAccess {
  readonly userId: string;
  readonly thread: Thread;
}

type ThreadNativeStatusObservation =
  | ({ readonly catId: string; readonly observation: 'available' } & ProviderNativeStatus)
  | {
      readonly catId: string;
      readonly runtimeSessionId: string;
      readonly observation: 'unavailable';
      readonly reason: 'provider_request_failed';
    };

export async function nativeThreadStatusRoutes(
  app: FastifyInstance,
  options: NativeThreadStatusRouteOptions,
): Promise<void> {
  app.get<ThreadParams>('/api/threads/:threadId/native-status', async (request, reply) => {
    const access = await resolveAccess(request, reply, options);
    if (!access) return;
    const sessions = await options.sessionChainStore.getChainByThread(access.thread.id);
    const candidates = sessions.filter(
      (session) =>
        session.status === 'active' &&
        session.userId === access.userId &&
        !!session.cliSessionId &&
        options.agentRegistry.has(session.catId) &&
        !!options.agentRegistry.get(session.catId).requestNativeStatus,
    );
    const statuses = await Promise.all(candidates.map((session) => readNativeStatus(app, options, access, session)));
    return reply.send({ statuses });
  });

  app.post<ForkParams>('/api/threads/:threadId/sessions/:catId/fork-native', async (request, reply) => {
    const source = await resolveAccess(request, reply, options);
    if (!source) return;
    const targetThreadId = request.body?.targetThreadId?.trim();
    if (!targetThreadId || targetThreadId === source.thread.id) {
      return reply.status(400).send({ error: 'A distinct Clowder AI target thread is required' });
    }
    const targetThread = await options.threadStore.get(targetThreadId);
    if (!targetThread) return reply.status(404).send({ error: 'Target thread not found' });
    if (!canAccessThread(targetThread, source.userId)) return reply.status(403).send({ error: 'Access denied' });

    const catId = request.params.catId as CatId;
    const sourceSession = await options.sessionChainStore.getActive(catId, source.thread.id, source.userId);
    if (!sourceSession?.cliSessionId || !options.agentRegistry.has(catId)) {
      return reply.status(409).send(unsupported('NATIVE_FORK_UNSUPPORTED'));
    }
    const service = options.agentRegistry.get(catId);
    if (!service.requestNativeFork) return reply.status(409).send(unsupported('NATIVE_FORK_UNSUPPORTED'));

    const targetSession = await options.sessionChainStore.getOrCreateActive({
      threadId: targetThreadId,
      catId,
      userId: source.userId,
    });
    if (targetSession.cliSessionId) {
      return reply.status(409).send({ error: 'Target session is already bound', code: 'NATIVE_FORK_TARGET_BOUND' });
    }

    try {
      const fork = await service.requestNativeFork({
        sessionId: sourceSession.cliSessionId,
        invocationId: `native-fork-${randomUUID()}`,
        timeoutMs: 60_000,
      });
      const bound = await options.sessionChainStore.bindCliSessionIdIfUnbound(
        targetSession.id,
        fork.forkedRuntimeSessionId,
      );
      if (!bound) {
        return reply.status(409).send({
          error: 'Native fork could not bind the Clowder AI target',
          code: 'NATIVE_FORK_BIND_CONFLICT',
          providerEvidence: { runtimeSessionId: fork.forkedRuntimeSessionId, binding: 'unbound' },
        });
      }
      return reply.send({
        outcome: 'bound',
        targetThreadId,
        targetSessionId: targetSession.id,
        runtimeSessionId: fork.forkedRuntimeSessionId,
        source: fork.source,
        observedAt: fork.observedAt,
      });
    } catch (error) {
      app.log.warn(
        { err: error, threadId: source.thread.id, targetThreadId, catId },
        'F306 native fork request failed',
      );
      return reply.status(409).send({ error: 'Native session unavailable', code: 'NATIVE_SESSION_UNAVAILABLE' });
    }
  });
}

async function readNativeStatus(
  app: FastifyInstance,
  options: NativeThreadStatusRouteOptions,
  access: ThreadAccess,
  session: SessionRecord,
): Promise<ThreadNativeStatusObservation> {
  const service = options.agentRegistry.get(session.catId);
  const runtimeSessionId = session.cliSessionId;
  const requestNativeStatus = service.requestNativeStatus;
  if (!runtimeSessionId || !requestNativeStatus) {
    return unavailableStatus(session.catId, runtimeSessionId ?? 'unavailable');
  }
  try {
    const cwd = session.workingDirectory ?? access.thread.projectPath;
    const status = await requestNativeStatus.call(service, {
      sessionId: runtimeSessionId,
      invocationId: `native-status-${randomUUID()}`,
      timeoutMs: 30_000,
      ...(cwd ? { cwd } : {}),
    });
    return status
      ? ({ catId: session.catId, observation: 'available', ...status } satisfies ThreadNativeStatusObservation)
      : unavailableStatus(session.catId, runtimeSessionId);
  } catch (error) {
    app.log.warn(
      { err: error, threadId: access.thread.id, catId: session.catId, runtimeSessionId },
      'F306 native status request failed',
    );
    return unavailableStatus(session.catId, runtimeSessionId);
  }
}

async function resolveAccess(
  request: FastifyRequest<ThreadParams>,
  reply: FastifyReply,
  options: NativeThreadStatusRouteOptions,
): Promise<ThreadAccess | null> {
  const userId = resolveStrictUserId(request);
  if (!userId) return reply.status(401).send({ error: 'Identity required' });
  const thread = await options.threadStore.get(request.params.threadId);
  if (!thread) return reply.status(404).send({ error: 'Thread not found' });
  if (!canAccessThread(thread, userId)) return reply.status(403).send({ error: 'Access denied' });
  return { userId, thread };
}

function unavailableStatus(catId: string, runtimeSessionId: string): ThreadNativeStatusObservation {
  return {
    catId,
    runtimeSessionId,
    observation: 'unavailable',
    reason: 'provider_request_failed',
  };
}

function unsupported(code: string): { error: string; code: string } {
  return { error: 'Native fork unsupported', code };
}
