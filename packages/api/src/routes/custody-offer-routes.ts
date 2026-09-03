import type { CatId, CustodyAdmissionResultV1 } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { deriveGrowingSourceMessageRevision } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStoreContract.js';
import {
  type AcceptedCustodyAdmissionCommand,
  type AcceptedCustodyTaskDraft,
  type CustodyOfferDecisionResult,
  type CustodyOfferReadResult,
  CustodyOfferService,
  type RecordPendingOfferResult,
} from '../domains/growing/CustodyOfferService.js';
import { EntrustedWorkLifecycleService } from '../domains/growing/EntrustedWorkLifecycleService.js';
import { resolveStrictUserId } from '../utils/request-identity.js';
import {
  type AgentKeyAuthRegistry,
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
} from './callback-auth-prehandler.js';
import { deriveCallbackActor } from './callback-scope-helpers.js';
import {
  custodyOfferRecognitionSchema,
  custodyOfferReferenceSchema,
  custodyOfferRefusalSchema,
  custodyOfferRetryAdmissionSchema,
  custodyOfferSourceParamsSchema,
} from './messages.schema.js';

interface CustodyOfferSocketPublisher {
  broadcastToRoom(room: string, event: string, data: unknown): void;
}

export interface CustodyOfferRoutesOptions {
  messageStore: IMessageStore;
  taskStore: ITaskStore;
  callbackRegistry: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
  socketManager?: CustodyOfferSocketPublisher | null;
  now?: () => number;
}

const POLICY_VERSION = 'custody-recognition-v1';

function offerIdFor(sourceMessageId: string): string {
  return `custody-offer:${sourceMessageId}`;
}

function idempotencyKeyFor(offerId: string): string {
  return `custody:${offerId}`;
}

function sourceRef(sourceMessageId: string): string {
  return `message:${sourceMessageId}`;
}

function isUsableSource(message: StoredMessage): boolean {
  return message.catId === null && !message.recall && !message._tombstone;
}

function defaultTaskDraft(source: StoredMessage): AcceptedCustodyTaskDraft | null {
  const intendedOutcome = source.content.trim();
  if (!intendedOutcome) return null;
  const firstLine = intendedOutcome.split(/\r?\n/, 1)[0]?.trim() || intendedOutcome;
  return {
    title: firstLine.slice(0, 200),
    why: `Accepted from source message ${source.id}`,
    intendedOutcome,
    closure: {
      condition: 'The outcome described by the source message is complete and reviewable.',
      expectedSignal: `${sourceRef(source.id)}#closure-evidence`,
    },
  };
}

function mapResult(
  reply: FastifyReply,
  result: CustodyOfferReadResult | RecordPendingOfferResult | CustodyOfferDecisionResult,
) {
  if (result.kind === 'not_found') {
    reply.status(404);
    return { error: 'Source message not found' };
  }
  if (result.kind === 'invalid_source') {
    reply.status(409);
    return { error: 'Source message cannot carry a custody offer' };
  }
  if (result.kind === 'stale_source') {
    reply.status(409);
    return { error: 'Source message revision is stale' };
  }
  if (result.kind === 'conflict') {
    reply.status(409);
    return { error: 'Custody offer state changed', offer: result.offer };
  }
  return result;
}

async function readAcceptedSource(
  options: CustodyOfferRoutesOptions,
  command: AcceptedCustodyAdmissionCommand,
): Promise<StoredMessage | null> {
  const source = await options.messageStore.getById(command.sourceMessageId);
  if (!source || !isUsableSource(source)) return null;
  if (deriveGrowingSourceMessageRevision(source) !== command.sourceMessageRevision) return null;
  return source;
}

async function publishAdmissionTask(
  options: CustodyOfferRoutesOptions,
  admission: CustodyAdmissionResultV1,
): Promise<void> {
  if (admission.result === 'needs_clarification') return;
  const taskId = admission.ownerRef.slice('task:item:'.length);
  const task = await options.taskStore.get(taskId);
  if (!task) return;
  options.socketManager?.broadcastToRoom(
    `thread:${task.threadId}`,
    admission.result === 'admitted' ? 'task_created' : 'task_updated',
    task,
  );
}

async function admitAcceptedOffer(
  options: CustodyOfferRoutesOptions,
  lifecycle: EntrustedWorkLifecycleService,
  command: AcceptedCustodyAdmissionCommand,
): Promise<CustodyAdmissionResultV1> {
  const source = await readAcceptedSource(options, command);
  if (!source) {
    return {
      result: 'needs_clarification',
      clarificationReason: 'The exact source message is no longer available for admission.',
    };
  }
  const draft = command.taskDraft ?? defaultTaskDraft(source);
  const admission = await lifecycle.admitOrResume({
    task: {
      threadId: source.threadId,
      title: draft?.title ?? 'Clarify entrusted work from the source conversation',
      why: draft?.why ?? `Accepted from source message ${source.id}`,
      createdBy: (draft?.ownerCatId ?? 'system') as CatId | 'system',
      ownerCatId: draft?.ownerCatId ?? null,
      userId: source.userId,
    },
    admission: {
      basis: 'accepted_offer',
      sourceRefs: [sourceRef(source.id)],
      offerId: command.offerId,
      sourceMessageRevision: command.sourceMessageRevision,
      ...(draft ? { intendedOutcome: draft.intendedOutcome } : {}),
      idempotencyKey: command.idempotencyKey,
    },
    ...(draft ? { closure: draft.closure } : {}),
    ...(draft?.time ? { time: draft.time } : {}),
    ...(draft?.artifactRefs ? { artifactRefs: draft.artifactRefs } : {}),
  });
  await publishAdmissionTask(options, admission);
  return admission;
}

export function registerCustodyOfferRoutes(app: FastifyInstance, options: CustodyOfferRoutesOptions): void {
  registerCallbackAuthHook(app, options.callbackRegistry, {
    ...(options.agentKeyRegistry ? { agentKeyRegistry: options.agentKeyRegistry } : {}),
  });
  const now = options.now ?? Date.now;
  const lifecycle = new EntrustedWorkLifecycleService(options.taskStore, { now });
  const service = new CustodyOfferService(options.messageStore, {
    admitOrResumeAcceptedOffer: async (command) => admitAcceptedOffer(options, lifecycle, command),
  });

  async function loadWebSource(request: { params: unknown }, reply: FastifyReply) {
    const userId = resolveStrictUserId(request as never);
    if (!userId) {
      reply.status(401);
      return null;
    }
    const params = custodyOfferSourceParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.status(400);
      return null;
    }
    const source = await options.messageStore.getById(params.data.sourceMessageId);
    if (!source || source.userId !== userId || !isUsableSource(source)) {
      reply.status(404);
      return null;
    }
    return { source, userId };
  }

  function notifySource(source: StoredMessage): void {
    options.socketManager?.broadcastToRoom(`thread:${source.threadId}`, 'custody_offer_updated', {
      messageId: source.id,
      threadId: source.threadId,
    });
  }

  app.get('/api/messages/:sourceMessageId/custody-offer', async (request, reply) => {
    const owned = await loadWebSource(request, reply);
    if (!owned) return { error: 'Custody offer not found' };
    return mapResult(reply, await service.readOffer(owned.source.id));
  });

  app.post('/api/messages/:sourceMessageId/custody-offer/accept', async (request, reply) => {
    const owned = await loadWebSource(request, reply);
    if (!owned) return { error: 'Custody offer not found' };
    const body = custodyOfferReferenceSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid custody offer reference' };
    }
    const result = await service.acceptOffer({
      sourceMessageId: owned.source.id,
      ...body.data,
      actorRef: `user:${owned.userId}`,
      dispositionAt: now(),
      idempotencyKey: idempotencyKeyFor(body.data.offerId),
    });
    if (result.kind === 'accepted' && result.transitioned) notifySource(owned.source);
    return mapResult(reply, result);
  });

  app.post('/api/messages/:sourceMessageId/custody-offer/refuse', async (request, reply) => {
    const owned = await loadWebSource(request, reply);
    if (!owned) return { error: 'Custody offer not found' };
    const body = custodyOfferRefusalSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid custody refusal' };
    }
    const result = await service.refuseOffer({
      sourceMessageId: owned.source.id,
      ...body.data,
      actorRef: `user:${owned.userId}`,
      dispositionAt: now(),
    });
    if ((result.kind === 'declined' || result.kind === 'dismissed') && result.transitioned) notifySource(owned.source);
    return mapResult(reply, result);
  });

  app.post('/api/callbacks/custody-offers', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);
    const body = custodyOfferRecognitionSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid custody recognition request' };
    }
    const source = await options.messageStore.getById(body.data.sourceMessageId);
    if (!source || source.userId !== actor.userId || source.threadId !== actor.threadId || !isUsableSource(source)) {
      reply.status(404);
      return { error: 'Source message not found in this invocation scope' };
    }
    const sourceMessageRevision = deriveGrowingSourceMessageRevision(source);
    const result = await service.recordPendingOffer({
      sourceMessageId: source.id,
      sourceMessageRevision,
      offerId: offerIdFor(source.id),
      policyVersion: POLICY_VERSION,
      reasonCode: body.data.reasonCode,
    });
    if (result.kind === 'recorded') notifySource(source);
    return { ...mapResult(reply, result), sourceMessageRevision };
  });

  app.post('/api/callbacks/custody-offers/retry-admission', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);
    const body = custodyOfferRetryAdmissionSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid custody admission retry', details: body.error.issues };
    }
    const source = await options.messageStore.getById(body.data.sourceMessageId);
    if (!source || source.userId !== actor.userId || source.threadId !== actor.threadId || !isUsableSource(source)) {
      reply.status(404);
      return { error: 'Source message not found in this invocation scope' };
    }
    const result = await service.retryAcceptedAdmission({
      sourceMessageId: source.id,
      sourceMessageRevision: body.data.sourceMessageRevision,
      offerId: body.data.offerId,
      taskDraft: {
        title: body.data.title,
        why: body.data.why,
        intendedOutcome: body.data.intendedOutcome,
        closure: body.data.closure,
        ...(body.data.time ? { time: body.data.time } : {}),
        ...(body.data.artifactRefs ? { artifactRefs: body.data.artifactRefs } : {}),
        ownerCatId: actor.catId,
      },
    });
    if (result.kind === 'accepted' && result.transitioned) notifySource(source);
    return mapResult(reply, result);
  });
}
