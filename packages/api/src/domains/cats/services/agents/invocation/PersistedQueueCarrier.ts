import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';

export type OwnedQueueProgress =
  | 'started'
  | 'owned_deferred_busy'
  | 'owned_deferred_paused'
  | 'owned_deferred_suppressed'
  | 'already_processing'
  | 'terminal_owned';

export interface PersistedCarrierCoordinates {
  sourceMessageId: string;
  ownerUserId: string;
  threadId: string;
  targetCatId: string;
  expectedEntryId?: string;
}

export type PersistedCarrierResult =
  | { state: OwnedQueueProgress; entryId: string }
  | { state: 'unavailable' | 'conflict'; reason: string };

export interface PersistedCarrierDeps {
  messages: Pick<IMessageStore, 'getById'>;
  queue: Pick<InvocationQueue, 'getDurableEntry'>;
  progress: (entry: QueueEntry, targetCatId: string) => Promise<OwnedQueueProgress>;
}

/** Verify the canonical Queue row for one persisted source before requesting normal Dispatch progress. */
export async function ensurePersistedCarrierOwnedAndScheduled(
  deps: PersistedCarrierDeps,
  input: PersistedCarrierCoordinates,
): Promise<PersistedCarrierResult> {
  try {
    const source = await deps.messages.getById(input.sourceMessageId);
    if (
      !source ||
      source.threadId !== input.threadId ||
      source.userId !== input.ownerUserId ||
      source.deliveryStatus === 'canceled'
    ) {
      return { state: 'unavailable', reason: 'Persisted source is unavailable' };
    }
    const entryId = input.expectedEntryId;
    if (!entryId) return { state: 'conflict', reason: 'Queue entry identity is required' };
    const entry = await deps.queue.getDurableEntry(input.threadId, entryId);
    if (
      !entry ||
      entry.payload.messageId !== source.id ||
      entry.owner.kind !== 'user' ||
      entry.owner.userId !== input.ownerUserId ||
      !entry.targets.includes(input.targetCatId)
    ) {
      return { state: 'conflict', reason: 'Queue ledger coordinates do not match the persisted source' };
    }
    if (entry.status === 'claimed' || entry.status === 'processing') {
      return { state: 'already_processing', entryId };
    }
    if (entry.status === 'terminal') return { state: 'terminal_owned', entryId };
    return { state: await deps.progress(entry, input.targetCatId), entryId };
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}
