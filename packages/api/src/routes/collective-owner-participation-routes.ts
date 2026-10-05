import { type CollectiveConnector, desiredParticipationSchema } from '@cat-cafe/collective-connector';
import { type CatId, collectiveSourceIdentitySchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { CollectiveCurrentContext } from '../domains/plugin/builtin-runtime/collective-current-context.js';
import {
  type ParticipationCat,
  reconcileParticipation,
} from '../domains/plugin/builtin-runtime/collective-participation-reconciler.js';
import type { CollectiveWorkAuthority } from '../domains/plugin/builtin-runtime/collective-work-authority.js';
import type { CollectiveWorkDispatcher } from '../domains/plugin/builtin-runtime/collective-work-dispatcher.js';
import { sendCollectiveOwnerError } from './collective-owner-errors.js';
import { registerCollectiveOwnerListeningRoutes } from './collective-owner-listening-routes.js';
import { prepareManualCollectiveAdmission } from './collective-owner-manual-admission.js';
import { collectiveOwnerParticipationView } from './collective-owner-participation-view.js';
import { collectiveWorkContinuation } from './collective-owner-work-continuation.js';
import { registerCollectiveOwnerWorkPolicyRoutes } from './collective-owner-work-policy-routes.js';
import {
  type CollectiveWorkReconsiderationRuntime,
  registerCollectiveOwnerWorkReconsiderationRoutes,
} from './collective-owner-work-reconsideration.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

interface OwnerParticipationOptions {
  readonly connector: () => CollectiveConnector | undefined;
  readonly cats: () => readonly ParticipationCat[];
  readonly threads: Pick<IThreadStore, 'get' | 'list' | 'create' | 'addParticipants'>;
  readonly messages: IMessageStore;
  readonly tasks: ITaskStore;
  readonly context: CollectiveCurrentContext;
  readonly work: CollectiveWorkAuthority;
  readonly dispatcher: CollectiveWorkDispatcher;
  readonly reconsideration?: CollectiveWorkReconsiderationRuntime;
}
const base = '/api/plugins/collective-connector/:connectionId';
type Request<Body = unknown> = { Params: { connectionId: string }; Body: Body };
const participationInput = z
  .object({
    catId: z.string().min(1).max(120),
    enabled: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
    channelIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
    standingWork: z
      .object({
        requestingHumanIds: z.array(z.string().min(1).max(160)).min(1).max(100),
        threadId: z.string().min(1).max(240).optional(),
        expiresAt: z.string().datetime().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
const reconcileInput = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    channelIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
  })
  .strict();
const policyInput = reconcileInput.extend({ policy: desiredParticipationSchema }).strict();
const workInput = z
  .object({
    sourceMessageId: z.string().min(1).max(240),
    requestId: z.string().uuid(),
    businessDeadline: z.number().int().positive().optional(),
    threadId: z.string().min(1).max(240).optional(),
  })
  .strict();
const resumeInput = z
  .object({
    taskId: z.string().min(1).max(240),
    observedRevision: z.number().int().positive(),
    requestId: z.string().uuid(),
  })
  .strict();

export function registerCollectiveOwnerParticipationRoutes(app: FastifyInstance, options: OwnerParticipationOptions) {
  registerCollectiveOwnerWorkPolicyRoutes(app, options.connector);
  registerCollectiveOwnerListeningRoutes(app, options.connector);
  registerCollectiveOwnerWorkReconsiderationRoutes(app, options);
  // Serialize Host setup effects for one connection. Durable authority stays in Connector/Task.
  const mutationTails = new Map<string, Promise<void>>();
  const mutate =
    (handler: (request: FastifyRequest<Request>, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest<Request>, reply: FastifyReply) => {
      const key = request.params.connectionId;
      const previous = mutationTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      mutationTails.set(key, tail);
      await previous;
      try {
        return await handler(request, reply);
      } finally {
        release();
        if (mutationTails.get(key) === tail) mutationTails.delete(key);
      }
    };
  const authorize = async (request: FastifyRequest<Request>, reply: FastifyReply, operation: 'read' | 'write') => {
    const access = requirePluginOwnerLocalAccess(request, operation);
    if ('error' in access) {
      reply.send(pluginAccessError(reply, access));
      return undefined;
    }
    const connector = options.connector();
    if (!connector) {
      reply.code(409).send({ code: 'CONNECTOR_INACTIVE' });
      return undefined;
    }
    const connection = await connector.getProjection(request.params.connectionId);
    const route = await connector.getHostRoute(connection.connectionId);
    if (route && route.localOwnerUserId !== access.operator) {
      reply.code(403).send({ code: 'CONNECTOR_OWNER_MISMATCH' });
      return undefined;
    }
    return { connector, connection, route, userId: access.operator };
  };
  app.get<Request>(`${base}/participation`, async (request, reply) => {
    try {
      const auth = await authorize(request, reply, 'read');
      if (!auth) return;
      return await collectiveOwnerParticipationView(options, auth);
    } catch (error) {
      return ownerError(reply, error);
    }
  });
  app.post<Request>(
    `${base}/participation/reconcile`,
    mutate(async (request, reply) => {
      try {
        const auth = await authorize(request, reply, 'write');
        if (!auth) return;
        const input = reconcileInput.parse(request.body);
        requireConnected(auth.connection);
        const route = await reconcileParticipation({
          connector: auth.connector,
          threads: options.threads,
          connectionId: auth.connection.connectionId,
          ownerUserId: auth.userId,
          route: auth.route,
          expectedRevision: input.expectedRevision,
          channelIds: input.channelIds,
          cats: options.cats(),
          initialExcludedCatIds: auth.connection.initialExcludedCatIds,
        });
        return { revision: route.revision, published: true };
      } catch (error) {
        return ownerError(reply, error);
      }
    }),
  );
  app.put<Request>(
    `${base}/participation/policy`,
    mutate(async (request, reply) => {
      try {
        const auth = await authorize(request, reply, 'write');
        if (!auth) return;
        const input = policyInput.parse(request.body);
        requireConnected(auth.connection);
        const route = await reconcileParticipation({
          connector: auth.connector,
          threads: options.threads,
          connectionId: auth.connection.connectionId,
          ownerUserId: auth.userId,
          route: auth.route,
          expectedRevision: input.expectedRevision,
          channelIds: input.channelIds,
          cats: options.cats(),
          policy: input.policy,
          initialExcludedCatIds: auth.connection.initialExcludedCatIds,
        });
        return { revision: route.revision, published: true };
      } catch (error) {
        return ownerError(reply, error);
      }
    }),
  );
  app.put<Request>(
    `${base}/participation`,
    mutate(async (request, reply) => {
      try {
        const auth = await authorize(request, reply, 'write');
        if (!auth) return;
        const input = participationInput.parse(request.body);
        if ((auth.route?.revision ?? 0) !== input.expectedRevision)
          return reply.code(409).send({ code: 'PARTICIPATION_REVISION_CONFLICT' });
        const cat = options.cats().find((value) => value.id === input.catId);
        if (!cat || (input.enabled && !cat.supported))
          return reply.code(422).send({ code: 'PARTICIPATION_UNSUPPORTED' });
        if (!auth.connection.authorizedHumanId || auth.connection.authorityStatus !== 'connected')
          return reply.code(409).send({ code: 'PARTICIPATION_REVOKED' });
        const key = `${auth.connection.authorizedHumanId}:${cat.id}`;
        const existing = auth.route?.agentRoutes[key];
        const threadId =
          existing?.threadId ?? (await ownedThread(options, auth.userId, cat.id, undefined, 'Collective 公共参与'));
        await ownedThread(options, auth.userId, cat.id, threadId);
        const agentRoutes = { ...auth.route?.agentRoutes };
        agentRoutes[key] = {
          catId: cat.id,
          threadId,
          ...(input.enabled ? { participation: { displayName: cat.displayName, channelIds: input.channelIds } } : {}),
          ...(input.enabled && input.standingWork
            ? {
                standingWork: {
                  ...input.standingWork,
                  channelIds: input.channelIds,
                },
              }
            : {}),
        };
        const route = await auth.connector.setHostRoute(
          auth.connection.connectionId,
          {
            localOwnerUserId: auth.userId,
            defaultIngressThreadId: auth.route?.defaultIngressThreadId ?? threadId,
            humanNotificationThreadId: auth.route?.humanNotificationThreadId ?? threadId,
            agentRoutes,
          },
          input.expectedRevision,
        );
        await auth.connector.publishParticipation(auth.connection.connectionId);
        return { revision: route.revision, published: true };
      } catch (error) {
        return ownerError(reply, error);
      }
    }),
  );
  app.post<Request>(
    `${base}/work/admit`,
    mutate(async (request, reply) => {
      try {
        const auth = await authorize(request, reply, 'write');
        if (!auth) return;
        const input = workInput.parse(request.body);
        const source = await options.messages.getById(input.sourceMessageId);
        const identity = collectiveSourceIdentitySchema.safeParse(source?.source?.meta?.participation);
        if (
          !source ||
          !identity.success ||
          identity.data.connectionId !== auth.connection.connectionId ||
          source.userId !== auth.userId
        )
          return reply.code(409).send({ code: 'RETURN_UNAVAILABLE' });
        const publicSource = await options.context.resolvePublic({
          userId: auth.userId,
          threadId: source.threadId,
          catId: identity.data.catId,
          originTriggerMessageId: source.id,
        });
        if (!publicSource) return reply.code(409).send({ code: 'RETURN_UNAVAILABLE' });
        const result = await prepareManualCollectiveAdmission({
          connector: auth.connector,
          connectionId: auth.connection.connectionId,
          ownerUserId: auth.userId,
          source,
          identity: identity.data,
          requestId: input.requestId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.businessDeadline ? { businessDeadline: input.businessDeadline } : {}),
          messages: options.messages,
          tasks: options.tasks,
          authority: options.work,
          resolveThread: (catId, preferred) =>
            ownedThread(options, auth.userId, catId, preferred, 'Collective 私人工作'),
        });
        if (result.result === 'needs_clarification') return reply.code(422).send(result);
        return await options.dispatcher.dispatch(result.task, auth.userId, result.revision, { kind: 'admission' });
      } catch (error) {
        return ownerError(reply, error);
      }
    }),
  );
  app.post<Request>(
    `${base}/work/resume`,
    mutate(async (request, reply) => {
      try {
        const auth = await authorize(request, reply, 'write');
        if (!auth) return;
        const input = resumeInput.parse(request.body);
        const task = await options.tasks.get(input.taskId);
        if (!task || task.userId !== auth.userId) return reply.code(404).send({ code: 'TASK_UNAVAILABLE' });
        const source = await options.work.sourceForTask(task);
        const identity = collectiveSourceIdentitySchema.safeParse(source.source?.meta?.participation);
        if (!identity.success || identity.data.connectionId !== auth.connection.connectionId)
          return reply.code(409).send({ code: 'RETURN_UNAVAILABLE' });
        const prepared = await auth.connector.withSynchronizedAssignedWorkAuthority(
          auth.connection.connectionId,
          identity.data.eventId,
          async (scope) => {
            const execution = await options.work.executionPointerForWork(task, scope.work);
            const currentSource = await options.work.sourceForTask(task, execution.sourceRef);
            const currentIdentity = collectiveSourceIdentitySchema.parse(currentSource.source?.meta?.participation);
            const continuation = collectiveWorkContinuation(scope, currentIdentity, currentSource.id);
            return {
              kind: 'resume' as const,
              requestId: input.requestId,
              ...continuation,
              ...execution,
            };
          },
        );
        return await options.dispatcher.dispatch(task, auth.userId, input.observedRevision, prepared);
      } catch (error) {
        return ownerError(reply, error);
      }
    }),
  );
}

function requireConnected(connection: { authorizedHumanId?: string; authorityStatus: string }) {
  if (!connection.authorizedHumanId || connection.authorityStatus !== 'connected') {
    throw Object.assign(new Error('Collective participation authority is revoked'), { code: 'PARTICIPATION_REVOKED' });
  }
}

async function ownedThread(
  options: OwnerParticipationOptions,
  userId: string,
  catId: string,
  threadId?: string,
  title?: string,
) {
  const thread = threadId ? await options.threads.get(threadId) : await options.threads.create(userId, title);
  if (!thread || thread.deletedAt || thread.createdBy !== userId)
    throw Object.assign(new Error('Owner Thread is unavailable'), { code: 'ROUTE_THREAD_UNAVAILABLE' });
  if (!thread.participants.includes(catId as CatId)) await options.threads.addParticipants(thread.id, [catId as CatId]);
  return thread.id;
}
function ownerError(reply: FastifyReply, error: unknown) {
  return sendCollectiveOwnerError(reply, error, 'INVALID_PARTICIPATION_REQUEST', 'PARTICIPATION_UNAVAILABLE');
}
