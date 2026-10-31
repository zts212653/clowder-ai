import { isDeepStrictEqual } from 'node:util';
import type { LifecycleStoredMessageMetadata } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../stores/ports/MessageStore.js';
import type { InvocationQueue } from '../InvocationQueue.js';
import type { QueueLedgerEntry } from './QueueLedger.js';

export type QueueTargetExecutionReadPort = Pick<InvocationQueue, 'getDurableEntriesForMessages'>;
type Response = Extract<LifecycleStoredMessageMetadata, { kind: 'response' }>;
type ExecutionFact =
  | { kind: 'pending'; entry: QueueLedgerEntry }
  | { kind: 'response'; message: StoredMessage; response: Response };

/** Read-only evidence, never a receipt, adoption, retirement or continuation grant. */
export async function readQueueTargetExecution(
  messages: Pick<IMessageStore, 'getById'>,
  queue: QueueTargetExecutionReadPort | undefined,
  source: StoredMessage,
  targetId: string,
): Promise<ExecutionFact | undefined> {
  if (source.lifecycle?.kind !== 'input') return;
  const refs = source.lifecycle.dispatchRefs?.filter((ref) => ref.targetId === targetId) ?? [];
  if (refs.length > 1) return;
  const [ref] = refs;
  if (ref) {
    const message = await messages.getById(ref.statusMessageId);
    const response = message?.lifecycle;
    if (
      !message ||
      message.userId !== source.userId ||
      message.threadId !== source.threadId ||
      message.catId !== targetId ||
      response?.kind !== 'response' ||
      response.targetId !== targetId ||
      !response.inputMessageIds.includes(source.id)
    )
      return;
    return { kind: 'response', message, response };
  }
  if (!queue || source.recall || source.deliveryStatus === 'canceled') return;
  const rows = (await queue.getDurableEntriesForMessages(source.threadId, [source.id])).get(source.id) ?? [];
  const matching = rows.filter(
    (row) =>
      row.threadId === source.threadId &&
      row.owner.kind === 'user' &&
      row.owner.userId === source.userId &&
      row.payload.messageId === source.id &&
      row.payload.sourceRecordId === source.id &&
      isDeepStrictEqual(row.from, source.from) &&
      row.targets.includes(targetId) &&
      (row.status === 'queued' || row.status === 'claimed'),
  );
  const [entry] = matching;
  if (matching.length !== 1 || !entry) return;
  return { kind: 'pending', entry };
}
