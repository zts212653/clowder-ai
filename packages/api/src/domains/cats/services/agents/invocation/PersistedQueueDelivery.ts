import { isDeepStrictEqual } from 'node:util';
import { createCatId } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { InvocationQueue } from './InvocationQueue.js';
import {
  ensurePersistedCarrierOwnedAndScheduled,
  type PersistedCarrierDeps,
  type PersistedCarrierResult,
} from './PersistedQueueCarrier.js';
import { carrierEntryId } from './QueuedMessageCustodyCarrierProjection.js';
import { createInitialQueuedMessageCustody } from './QueuedMessageCustodyCoordinator.js';

export interface PersistedQueueDeliveryInput {
  ownerUserId: string;
  threadId: string;
  targetCatId: string;
  idempotencyKey: string;
  content: string;
  source: NonNullable<StoredMessage['source']>;
}

export interface PersistedQueueDeliveryPort {
  deliver(input: PersistedQueueDeliveryInput): Promise<PersistedCarrierResult & { message?: StoredMessage }>;
}

/** Dispatch owns the admission/resumption boundary; producers supply only an authorized immutable envelope. */
export class PersistedQueueDelivery implements PersistedQueueDeliveryPort {
  constructor(
    private readonly deps: {
      messages: Pick<IMessageStore, 'append' | 'getByIdempotencyKey' | 'getById' | 'getByThreadAfter'>;
      queue: Pick<
        InvocationQueue,
        | 'enqueue'
        | 'backfillMessageId'
        | 'rollbackEnqueue'
        | 'getEntrySnapshot'
        | 'restoreDurableEntry'
        | 'commitQueueCustodyAdmission'
      >;
      progress: PersistedCarrierDeps['progress'];
    },
  ) {}

  async deliver(input: PersistedQueueDeliveryInput) {
    let message = await this.deps.messages.getByIdempotencyKey(input.ownerUserId, input.threadId, input.idempotencyKey);
    if (!message) message = await this.admit(input);
    if (
      message.userId !== input.ownerUserId ||
      message.threadId !== input.threadId ||
      message.catId !== null ||
      message.content !== input.content ||
      message.source?.connector !== input.source.connector ||
      !isDeepStrictEqual(message.source.meta, input.source.meta) ||
      !message.mentions.some((cat) => cat === input.targetCatId)
    ) {
      return { state: 'conflict' as const, reason: 'Persisted producer envelope does not match', message };
    }
    const result = await ensurePersistedCarrierOwnedAndScheduled(
      {
        ...this.deps,
        progress: async (entry, targetCatId) => {
          // The complete durable group has been verified. Release only this admission's existing queue fence.
          if (
            !this.deps.queue.commitQueueCustodyAdmission(
              entry.threadId,
              entry.userId,
              `producer:${input.idempotencyKey}`,
              [entry.id],
            )
          )
            throw new Error('Producer queue admission fence changed');
          return this.deps.progress(entry, targetCatId);
        },
      },
      { ...input, sourceMessageId: message.id },
    );
    return { ...result, message };
  }

  private async admit(input: PersistedQueueDeliveryInput): Promise<StoredMessage> {
    const targetCat = createCatId(input.targetCatId);
    const queued = this.deps.queue.enqueue({
      threadId: input.threadId,
      userId: input.ownerUserId,
      ownerAuthProvenance: 'strict',
      idempotencyKey: input.idempotencyKey,
      queueCustodyAdmissionId: `producer:${input.idempotencyKey}`,
      content: input.content,
      source: 'connector',
      targetCats: [targetCat],
      intent: 'execute',
    });
    if (queued.outcome === 'full' || !queued.entry) throw new Error('Producer return queue is full');
    try {
      const message = await this.deps.messages.append({
        userId: input.ownerUserId,
        catId: null,
        content: input.content,
        mentions: [targetCat],
        timestamp: queued.entry.createdAt,
        threadId: input.threadId,
        idempotencyKey: input.idempotencyKey,
        deliveryStatus: 'queued',
        queueCustody: createInitialQueuedMessageCustody(queued.entry),
        source: input.source,
        extra: { targetCats: [targetCat] },
      });
      const durableEntryId = message.queueCustody && carrierEntryId(message.queueCustody, input.targetCatId);
      if (durableEntryId !== queued.entry.id) {
        // append's atomic idempotency check may find an older durable owner after our initial lookup.
        if (!queued.deduped) this.deps.queue.rollbackEnqueue(input.threadId, input.ownerUserId, queued.entry.id);
        return message;
      }
      this.deps.queue.backfillMessageId(input.threadId, input.ownerUserId, queued.entry.id, message.id);
      return message;
    } catch (error) {
      if (!queued.deduped) this.deps.queue.rollbackEnqueue(input.threadId, input.ownerUserId, queued.entry.id);
      throw error;
    }
  }
}
