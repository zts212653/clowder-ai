import { isDeepStrictEqual } from 'node:util';
import { createCatId } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';
import type { OwnedQueueProgress, PersistedCarrierResult } from './PersistedQueueCarrier.js';
import { queueEntryId } from './queue-ledger/QueueLedger.js';

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

type PersistedQueueDeliveryResult = PersistedCarrierResult & { message?: StoredMessage };

/** Dispatch owns atomic Message + Queue admission; producers supply only an authorized immutable envelope. */
export class PersistedQueueDelivery implements PersistedQueueDeliveryPort {
  constructor(
    private readonly deps: {
      messages: IMessageStore;
      queue: Pick<InvocationQueue, 'appendAndEnqueueDurable' | 'findAdmittedEntriesForMessages' | 'getDurableEntry'>;
      progress: (entry: QueueEntry, targetCatId: string) => Promise<OwnedQueueProgress>;
    },
  ) {}

  async deliver(input: PersistedQueueDeliveryInput) {
    const targetCat = createCatId(input.targetCatId);
    const from = {
      kind: 'external' as const,
      connectorId: input.source.connector,
      ...(input.source.label ? { sender: { id: input.source.label, name: input.source.label } } : {}),
    };
    const existing = await this.deps.messages.getByIdempotencyKey(
      input.ownerUserId,
      input.threadId,
      input.idempotencyKey,
    );
    if (existing) {
      return this.progressExistingMessage(existing, input);
    }
    const admitted = await this.deps.queue.appendAndEnqueueDurable(
      this.deps.messages,
      {
        userId: input.ownerUserId,
        threadId: input.threadId,
        from,
        content: input.content,
        mentions: [targetCat],
        timestamp: Date.now(),
        deliveryStatus: 'queued',
        source: input.source,
        extra: { targetCats: [targetCat] },
        idempotencyKey: input.idempotencyKey,
      },
      {
        threadId: input.threadId,
        userId: input.ownerUserId,
        sourceId: input.idempotencyKey,
        kind: 'conversation_input',
        ownerAuthProvenance: 'strict',
        idempotencyKey: input.idempotencyKey,
        content: input.content,
        from,
        targetCats: [targetCat],
        intent: 'execute',
      },
    );
    if (admitted.outcome === 'full') throw new Error('Producer return queue is full');
    const message = admitted.message;
    if (!matchesPersistedEnvelope(message, input)) {
      return { state: 'conflict' as const, reason: 'Persisted producer envelope does not match', message };
    }
    const entry = admitted.entry;
    if (!entry) return { state: 'unavailable' as const, reason: 'Queue admission is unavailable', message };
    if (entry.status === 'claimed' || entry.status === 'processing') {
      return { state: 'already_processing' as const, entryId: entry.id, message };
    }
    return { state: await this.deps.progress(entry, input.targetCatId), entryId: entry.id, message };
  }

  private async progressExistingMessage(
    existing: StoredMessage,
    input: PersistedQueueDeliveryInput,
  ): Promise<PersistedQueueDeliveryResult> {
    if (!matchesPersistedEnvelope(existing, input)) {
      return { state: 'conflict', reason: 'Persisted producer envelope does not match', message: existing };
    }
    const entryId = queueEntryId(existing.id);
    const entry = await this.deps.queue.getDurableEntry(input.threadId, entryId);
    if (entry) {
      if (entry.status === 'claimed' || entry.status === 'processing') {
        return { state: 'already_processing', entryId, message: existing };
      }
      if (entry.status === 'terminal') return { state: 'terminal_owned', entryId, message: existing };
      return { state: await this.deps.progress(entry, input.targetCatId), entryId, message: existing };
    }
    if (
      this.deps.queue.findAdmittedEntriesForMessages(
        input.threadId,
        [existing.id],
        input.ownerUserId,
        input.targetCatId,
      ).length > 0
    ) {
      return { state: 'already_processing', entryId, message: existing };
    }
    if (existing.deliveryStatus === 'delivered') {
      return { state: 'terminal_owned', entryId, message: existing };
    }
    return { state: 'conflict', reason: 'Persisted producer Queue carrier is missing', message: existing };
  }
}

function matchesPersistedEnvelope(message: StoredMessage, input: PersistedQueueDeliveryInput): boolean {
  return (
    message.userId === input.ownerUserId &&
    message.threadId === input.threadId &&
    message.content === input.content &&
    message.source?.connector === input.source.connector &&
    isDeepStrictEqual(message.source.meta, input.source.meta) &&
    message.mentions.some((cat) => cat === input.targetCatId)
  );
}
