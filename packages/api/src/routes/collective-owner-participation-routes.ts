import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import { type CatId, collectiveSourceIdentitySchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { containsEntrustedWorkTimeSignal } from '../domains/growing/EntrustedWorkSourceSignals.js';
import type { CollectiveCurrentContext } from '../domains/plugin/builtin-runtime/collective-current-context.js';
import type { CollectiveWorkAuthority } from '../domains/plugin/builtin-runtime/collective-work-authority.js';
import type { CollectiveWorkDispatcher } from '../domains/plugin/builtin-runtime/collective-work-dispatcher.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

interface OwnerParticipationOptions {
  readonly connector: () => CollectiveConnector | undefined;
  readonly cats: () => readonly { id: string; displayName: string; supported: boolean }[];
  readonly threads: Pick<IThreadStore, 'get' | 'list' | 'create' | 'addParticipants'>;
  readonly messages: IMessageStore;
  readonly tasks: ITaskStore;
  readonly context: CollectiveCurrentContext;
  readonly work: CollectiveWorkAuthority;
  readonly dispatcher: CollectiveWorkDispatcher;
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
      const inbox = await auth.connector.listInbox(auth.connection.connectionId);
      const sources = new Set(
        inbox.flatMap((item) =>
          item.routeReceipt?.kind === 'thread_message' ? [`message:${item.routeReceipt.messageId}`] : [],
        ),
      );
      const tasks = (await options.tasks.listByKind('work')).filter(
        (task) =>
          task.userId === auth.userId && task.entrustedWork?.admission.sourceRefs.some((ref) => sources.has(ref)),
      );
      const published = await auth.connector.isParticipationPublished(auth.connection.connectionId).catch(() => false);
      return {
        connection: auth.connection,
        revision: auth.route?.revision ?? 0,
        cats: options.cats(),
        bindings: auth.route?.agentRoutes ?? {},
        published,
        threads: (await options.threads.list(auth.userId))
          .filter((thread) => !thread.deletedAt)
          .map((thread) => ({ id: thread.id, title: thread.title, participants: thread.participants })),
        requests: inbox
          .filter(
            (item) =>
              item.event.recipient?.kind === 'agent' &&
              item.event.recipient.connectionId === auth.connection.connectionId,
          )
          .map((item) => ({
            event: item.event,
            delivery: item.disposition,
            failure: item.routeFailure,
            messageId: item.routeReceipt?.kind === 'thread_message' ? item.routeReceipt.messageId : undefined,
          })),
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          threadId: task.threadId,
          status: task.status,
          revision: task.entrustedWork!.revision,
          closure: task.entrustedWork!.closure.state,
          sourceRefs: task.entrustedWork!.admission.sourceRefs,
        })),
      };
    } catch (error) {
      return ownerError(reply, error);
    }
  });
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
                  threadId: await ownedThread(
                    options,
                    auth.userId,
                    cat.id,
                    input.standingWork.threadId,
                    'Collective 私人工作',
                  ),
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
        await options.context.resolvePublic({
          userId: auth.userId,
          threadId: source.threadId,
          catId: identity.data.catId,
          originTriggerMessageId: source.id,
        });
        if (containsEntrustedWorkTimeSignal(source.content) && !input.businessDeadline)
          return reply.code(422).send({ result: 'needs_clarification' });
        const existing = (await options.tasks.listByKind('work')).find(
          (task) =>
            task.userId === auth.userId &&
            task.ownerCatId === identity.data.catId &&
            task.entrustedWork?.admission.sourceRefs.length === 1 &&
            task.entrustedWork.admission.sourceRefs[0] === `message:${source.id}`,
        );
        if (existing && input.threadId && existing.threadId !== input.threadId)
          return reply.code(409).send({ code: 'OWNER_ADMISSION_CONFLICT' });
        const threadId = await ownedThread(
          options,
          auth.userId,
          identity.data.catId,
          existing?.threadId ?? input.threadId,
          'Collective 私人工作',
        );
        const result = await options.work.admit({
          ownerUserId: auth.userId,
          ownerAuthProvenance: 'strict',
          source,
          catId: identity.data.catId as CatId,
          threadId,
          requestId: input.requestId,
          title: source.content.slice(0, 160),
          intendedOutcome: source.content,
          ...(input.businessDeadline
            ? { time: { businessDeadline: { value: input.businessDeadline, sourceRef: `message:${source.id}` } } }
            : {}),
          closure: {
            condition: 'A reviewable result answers the entrusted request at its original Collective location',
            expectedSignal: 'collective:accepted-result',
          },
        });
        if (result.result === 'needs_clarification') return reply.code(422).send(result);
        const task = await options.tasks.get(result.subjectRef.slice('task:work:'.length));
        if (!task) throw new Error('Admitted Task is unavailable');
        return await options.dispatcher.dispatch(task, auth.userId, result.revision, { kind: 'admission' });
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
        return await options.dispatcher.dispatch(task, auth.userId, input.observedRevision, {
          kind: 'resume',
          requestId: input.requestId,
        });
      } catch (error) {
        return ownerError(reply, error);
      }
    }),
  );
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
  if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_PARTICIPATION_REQUEST' });
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'PARTICIPATION_UNAVAILABLE';
  return reply
    .code(409)
    .send({ code, error: error instanceof Error ? error.message : 'Collective action is unavailable' });
}
