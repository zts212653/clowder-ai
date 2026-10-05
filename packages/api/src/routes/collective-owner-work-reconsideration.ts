import { isDeepStrictEqual } from 'node:util';
import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import { collectiveSourceIdentitySchema, createCatId } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import { createInitialQueuedMessageCustody } from '../domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { buildQueueEntry } from '../domains/cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { collectiveSender, collectiveSource } from '../domains/plugin/builtin-runtime/collective-ingress-routing.js';
import { sendCollectiveOwnerError } from './collective-owner-errors.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

export interface CollectiveWorkReconsiderationRuntime {
  readonly queue: Pick<
    InvocationQueue,
    'enqueue' | 'backfillMessageId' | 'rollbackEnqueue' | 'getEntrySnapshot' | 'restoreDurableEntry'
  >;
  readonly processor: Pick<QueueProcessor, 'processNext'>;
}
interface ReconsiderationOptions {
  readonly connector: () => CollectiveConnector | undefined;
  readonly cats: () => readonly { id: string; supported: boolean }[];
  readonly messages: IMessageStore;
  readonly threads: Pick<IThreadStore, 'get'>;
  readonly reconsideration?: CollectiveWorkReconsiderationRuntime;
}
const reconsiderationInput = z
  .object({
    sourceEventId: z.string().regex(/^evt_[A-Za-z0-9_-]{8,}$/),
    catId: z.string().trim().min(1).max(120),
    grantRef: z.string().trim().min(1).max(240),
    grantRevision: z.number().int().positive(),
    requestKind: z.string().trim().min(1).max(240),
  })
  .strict();
type Request = { Params: { connectionId: string }; Body: unknown };

/** A strict owner can request another public classification under an already registered and adopted permission. */
export function registerCollectiveOwnerWorkReconsiderationRoutes(
  app: FastifyInstance,
  options: ReconsiderationOptions,
) {
  app.post<Request>('/api/plugins/collective-connector/:connectionId/work/reconsider', async (request, reply) => {
    try {
      const access = requirePluginOwnerLocalAccess(request, 'write');
      if ('error' in access) return pluginAccessError(reply, access);
      const input = reconsiderationInput.parse(request.body);
      const connector = options.connector();
      const runtime = options.reconsideration;
      if (!connector || !runtime) return reply.code(409).send({ code: 'WORK_RECONSIDERATION_UNAVAILABLE' });
      if (!options.cats().some((cat) => cat.id === input.catId && cat.supported))
        return reply.code(422).send({ code: 'PARTICIPATION_UNSUPPORTED' });
      const prepared = await connector.withWorkReconsiderationAuthority(
        request.params.connectionId,
        access.operator,
        input,
        async (scope) => {
          const original = await requireSource(options, access.operator, scope);
          const existing = await options.messages.getByIdempotencyKey(
            access.operator,
            scope.threadId,
            scope.purposeKey,
          );
          await scope.assertCurrentPermission();
          if (existing) return recoverWake(existing, scope, runtime, access.operator);
          const queued = runtime.queue.enqueue({
            userId: access.operator,
            threadId: scope.threadId,
            ownerAuthProvenance: 'unknown',
            executionScope: 'collective-participation',
            idempotencyKey: scope.purposeKey,
            content: scope.event.body,
            source: 'connector',
            targetCats: [createCatId(input.catId)],
            intent: 'execute',
            senderMeta: collectiveSender(scope.event),
            suggestedSkill: 'collective-participation',
          });
          if (!queued.entry || queued.outcome === 'full') throw unavailable('ROUTE_QUEUE_FULL');
          try {
            const source = collectiveSource(scope.event, scope.source);
            const stored = await options.messages.appendIdempotent({
              userId: access.operator,
              threadId: scope.threadId,
              catId: null,
              content: scope.event.body,
              source: {
                ...source,
                meta: {
                  ...source.meta,
                  reconsideration: {
                    sourceMessageId: original.id,
                    grantRef: scope.grantRef,
                    grantRevision: scope.grantRevision,
                    requestKind: scope.requestKind,
                    purposeKey: scope.purposeKey,
                  },
                },
              },
              mentions: [createCatId(input.catId)],
              timestamp: Date.now(),
              idempotencyKey: scope.purposeKey,
              deliveryStatus: 'queued',
              queueCustody: createInitialQueuedMessageCustody(queued.entry),
              extra: { targetCats: [input.catId] },
            });
            runtime.queue.backfillMessageId(scope.threadId, access.operator, queued.entry.id, stored.message.id);
            return response(scope, stored.message, 'queued');
          } catch (error) {
            if (!queued.deduped) runtime.queue.rollbackEnqueue(scope.threadId, access.operator, queued.entry.id);
            throw error;
          }
        },
      );
      if (prepared.disposition !== 'already_classified')
        void runtime.processor.processNext(prepared.threadId, access.operator).catch(() => {});
      return prepared;
    } catch (error) {
      return sendCollectiveOwnerError(
        reply,
        error,
        'INVALID_WORK_RECONSIDERATION_REQUEST',
        'WORK_RECONSIDERATION_UNAVAILABLE',
      );
    }
  });
}
type ReconsiderationScope = Parameters<Parameters<CollectiveConnector['withWorkReconsiderationAuthority']>[3]>[0];

async function requireSource(options: ReconsiderationOptions, ownerUserId: string, scope: ReconsiderationScope) {
  const original = await options.messages.getById(scope.sourceMessageId);
  const participation = original?.source?.meta?.participation;
  const identity = collectiveSourceIdentitySchema.safeParse(participation);
  const thread = await options.threads.get(scope.threadId);
  if (
    !original ||
    original.deletedAt ||
    original.recall ||
    original._tombstone ||
    original.catId !== null ||
    original.userId !== ownerUserId ||
    original.threadId !== scope.threadId ||
    original.source?.connector !== 'collective' ||
    original.content !== scope.event.body ||
    !identity.success ||
    !isDeepStrictEqual(identity.data, scope.source) ||
    thread?.createdBy !== ownerUserId ||
    thread.deletedAt ||
    !thread.participants.includes(createCatId(scope.source.catId))
  )
    throw unavailable('WORK_RECONSIDERATION_SOURCE_UNAVAILABLE');
  return original;
}

function recoverWake(
  existing: StoredMessage,
  scope: ReconsiderationScope,
  runtime: CollectiveWorkReconsiderationRuntime,
  ownerUserId: string,
) {
  const custody = existing.queueCustody;
  if (existing.recall || existing._tombstone || existing.deliveryStatus === 'canceled')
    throw unavailable('WORK_RECONSIDERATION_WITHDRAWN');
  if (!custody || custody.ownerAuthProvenance !== 'unknown' || custody.executionScope !== 'collective-participation')
    throw unavailable('WORK_RECONSIDERATION_CUSTODY_UNAVAILABLE');
  if (custody.status === 'terminal' && !custody.handledByCatIds.includes(createCatId(scope.source.catId)))
    throw unavailable('WORK_RECONSIDERATION_ALREADY_STOPPED');
  if (
    custody.status === 'queued' &&
    existing.deliveryStatus === 'queued' &&
    !runtime.queue.getEntrySnapshot(scope.threadId, ownerUserId, custody.entryId)
  )
    runtime.queue.restoreDurableEntry(buildQueueEntry([existing], custody.entryId));
  return response(scope, existing, custody.status === 'terminal' ? 'already_classified' : 'already_queued');
}

function response(
  scope: { source: { eventId: string; catId: string }; threadId: string; grantRef: string; grantRevision: number },
  message: StoredMessage,
  disposition: 'queued' | 'already_queued' | 'already_classified',
) {
  return {
    sourceEventId: scope.source.eventId,
    catId: scope.source.catId,
    messageId: message.id,
    threadId: scope.threadId,
    grantRef: scope.grantRef,
    grantRevision: scope.grantRevision,
    disposition,
  };
}
function unavailable(code: string) {
  return Object.assign(new Error('Current source reconsideration is unavailable'), { code });
}
