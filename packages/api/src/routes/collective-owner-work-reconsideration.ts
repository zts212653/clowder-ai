import { isDeepStrictEqual } from 'node:util';
import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import { collectiveSourceIdentitySchema, createCatId } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import { queueEntryId } from '../domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { collectiveSender, collectiveSource } from '../domains/plugin/builtin-runtime/collective-ingress-routing.js';
import { sendCollectiveOwnerError } from './collective-owner-errors.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

export interface CollectiveWorkReconsiderationRuntime {
  readonly queue: Pick<InvocationQueue, 'send' | 'getDurableEntry'>;
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
          if (existing) return recoverWake(existing, scope, runtime, options.messages, access.operator);
          const source = collectiveSource(scope.event, scope.source);
          const from = { kind: 'external' as const, connectorId: 'collective', sender: collectiveSender(scope.event) };
          const stored = await runtime.queue.send(
            options.messages,
            {
              userId: access.operator,
              threadId: scope.threadId,
              from,
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
              extra: { targetCats: [input.catId] },
            },
            {
              userId: access.operator,
              threadId: scope.threadId,
              sourceId: scope.purposeKey,
              kind: 'conversation_input',
              from,
              ownerAuthProvenance: 'unknown',
              executionScope: 'collective-participation',
              idempotencyKey: scope.purposeKey,
              content: scope.event.body,
              targetCats: [createCatId(input.catId)],
              intent: 'execute',
              suggestedSkill: 'collective-participation',
            },
          );
          if (stored.outcome === 'full') throw unavailable('ROUTE_QUEUE_FULL');
          return response(scope, stored.message, 'queued');
        },
      );
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

async function recoverWake(
  existing: StoredMessage,
  scope: ReconsiderationScope,
  runtime: CollectiveWorkReconsiderationRuntime,
  messages: Pick<IMessageStore, 'getById'>,
  ownerUserId: string,
) {
  if (existing.deletedAt || existing.recall || existing._tombstone || existing.deliveryStatus === 'canceled')
    throw unavailable('WORK_RECONSIDERATION_WITHDRAWN');
  if (
    existing.userId !== ownerUserId ||
    existing.threadId !== scope.threadId ||
    existing.content !== scope.event.body ||
    existing.from?.kind !== 'external' ||
    existing.from.connectorId !== 'collective' ||
    !isDeepStrictEqual(existing.source?.meta?.participation, scope.source) ||
    !isDeepStrictEqual(existing.source?.meta?.reconsideration, {
      sourceMessageId: scope.sourceMessageId,
      grantRef: scope.grantRef,
      grantRevision: scope.grantRevision,
      requestKind: scope.requestKind,
      purposeKey: scope.purposeKey,
    })
  )
    throw unavailable('WORK_RECONSIDERATION_CUSTODY_UNAVAILABLE');
  const entry = await runtime.queue.getDurableEntry(scope.threadId, queueEntryId(existing.id));
  if (entry) {
    if (
      entry.owner.kind !== 'user' ||
      entry.owner.userId !== ownerUserId ||
      entry.payload.messageId !== existing.id ||
      entry.payload.content !== existing.content ||
      entry.targets.length !== 1 ||
      entry.targets[0] !== scope.source.catId ||
      entry.execution.ownerAuthProvenance !== 'unknown' ||
      entry.execution.executionScope !== 'collective-participation'
    )
      throw unavailable('WORK_RECONSIDERATION_CUSTODY_UNAVAILABLE');
    return response(scope, existing, 'already_queued');
  }
  // History is an actual dispatch receipt, never a source for rebuilding work.
  const dispatch = existing.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === scope.source.catId);
  if (!dispatch) throw unavailable('WORK_RECONSIDERATION_CUSTODY_UNAVAILABLE');
  const child = await messages.getById(dispatch.statusMessageId);
  if (
    !child ||
    child.threadId !== scope.threadId ||
    child.userId !== ownerUserId ||
    child.lifecycle?.kind !== 'response' ||
    child.lifecycle.targetId !== scope.source.catId
  )
    throw unavailable('WORK_RECONSIDERATION_CUSTODY_UNAVAILABLE');
  if (dispatch.phase === 'dispatched') return response(scope, existing, 'already_queued');
  if (child.lifecycle.status !== 'completed' || !child.lifecycle.inputMessageIds.includes(existing.id))
    throw unavailable('WORK_RECONSIDERATION_ALREADY_STOPPED');
  return response(scope, existing, 'already_classified');
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
