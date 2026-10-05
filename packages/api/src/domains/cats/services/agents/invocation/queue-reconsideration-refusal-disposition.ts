import { collectiveSourceIdentitySchema } from '@cat-cafe/shared';
import type { CollectiveReconsiderationRefusalError } from '../../../../plugin/builtin-runtime/collective-work/collective-reconsideration-refusal.js';
import { collectiveReconsiderationMarkerSchema } from '../../../../plugin/builtin-runtime/collective-work/collective-reconsideration-source.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { QueueEntry } from './InvocationQueue.js';

/** Only the exact indexed Host owner wake may receive a public permanent-refusal disposition. */
export async function requireRefusedReconsiderationCarrier(input: {
  entry: QueueEntry;
  source: StoredMessage;
  refusal: CollectiveReconsiderationRefusalError;
  messages: Pick<IMessageStore, 'getByIdempotencyKey'>;
}): Promise<void> {
  const { entry, source, refusal, messages } = input;
  const marker = collectiveReconsiderationMarkerSchema.safeParse(source.source?.meta?.reconsideration);
  const participation = collectiveSourceIdentitySchema.safeParse(source.source?.meta?.participation);
  if (
    entry.executionScope !== 'collective-participation' ||
    entry.source !== 'connector' ||
    entry.ownerAuthProvenance !== 'unknown' ||
    source.catId !== null ||
    source.source?.connector !== 'collective' ||
    !marker.success ||
    !participation.success ||
    source.source.meta?.eventId !== participation.data.eventId ||
    participation.data.catId !== entry.targetCats[0] ||
    refusal.sourceMessageId !== source.id ||
    refusal.purposeKey !== marker.data.purposeKey ||
    (entry.idempotencyKey !== undefined && entry.idempotencyKey !== marker.data.purposeKey) ||
    source.queueCustody?.ownerAuthProvenance !== 'unknown'
  )
    throw new Error('Reconsideration refusal has no exact trusted Host source and purpose');
  const indexed = await messages.getByIdempotencyKey(entry.userId, entry.threadId, marker.data.purposeKey);
  if (indexed?.id !== source.id) throw new Error('Reconsideration refusal lost its durable purpose index');
}
