import { createHash } from 'node:crypto';
import type { ContentModificationRecord, ContentModificationRequestView } from '@cat-cafe/shared';
import { carrierEntryId } from '../../cats/services/agents/invocation/QueuedMessageCustodyCarrierProjection.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import { projectQueueReceipt } from '../../cats/services/stores/ports/queued-message-receipt.js';
import type { ITurnExecutionStore } from '../../cats/services/stores/ports/TurnExecutionStore.js';

/** A queue carrier, a started executor and a returned result are separate owner facts. */
export async function readModificationExecution(
  deps: {
    messages: Pick<IMessageStore, 'getByIdempotencyKey'>;
    turnExecutions?: Pick<ITurnExecutionStore, 'get'>;
  },
  record: ContentModificationRecord,
): Promise<ContentModificationRequestView['execution']> {
  const receiptRef = record.progress.review?.receiptRef;
  if (!receiptRef || !record.progress.task) return;
  const key = `f309-return:${createHash('sha256').update(receiptRef).digest('hex')}`;
  const message = await deps.messages.getByIdempotencyKey(record.ownerUserId, record.payload.threadId, key);
  if (
    !message ||
    message.userId !== record.ownerUserId ||
    message.threadId !== record.payload.threadId ||
    message.source?.connector !== 'content-review' ||
    message.source.meta?.reviewReceiptRef !== receiptRef ||
    message.source.meta.taskId !== record.progress.task?.taskId ||
    !message.mentions.includes(record.payload.targetCatId as (typeof message.mentions)[number])
  )
    return;
  const target = message.queueCustody
    ? projectQueueReceipt(message.queueCustody).targets.find((target) => target.catId === record.payload.targetCatId)
    : undefined;
  const latest = target?.attempts?.at(-1);
  const invocationId = latest?.invocationId ?? target?.invocationId;
  const queueEntryId = message.queueCustody
    ? carrierEntryId(message.queueCustody, record.payload.targetCatId)
    : undefined;
  const evidence = {
    messageId: message.id,
    ...(queueEntryId ? { queueEntryId } : {}),
    targetCatId: record.payload.targetCatId,
    ...(invocationId ? { invocationId } : {}),
    observedAt: latest?.updatedAt ?? message.timestamp,
    evidenceRef: `message:${message.id}#queue-custody`,
  };
  if (invocationId && deps.turnExecutions) {
    const invocation = await deps.turnExecutions.get(invocationId);
    if (
      !invocation ||
      invocation.userId !== record.ownerUserId ||
      invocation.threadId !== record.payload.threadId ||
      invocation.catId !== record.payload.targetCatId ||
      !(
        invocation.causal?.triggerMessageId === message.id || invocation.causal?.coveredMessageIds?.includes(message.id)
      )
    )
      return { ...evidence, state: 'unknown' };
    const fact = {
      ...evidence,
      parentInvocationId: invocation.parentInvocationId,
      observedAt: invocation.endedAt ?? invocation.startedAt,
      evidenceRef: `turn-execution:${invocation.invocationId}`,
    };
    switch (invocation.status) {
      case 'canceled':
        return { ...fact, state: 'cancelled' };
      case 'failed':
        return { ...fact, state: 'failed' };
      case 'succeeded':
        return { ...fact, state: 'finished' };
      case 'interrupted':
        return { ...fact, state: 'interrupted' };
      case 'running':
        return { ...fact, state: target?.state === 'withdrawn' ? 'withdrawn_running' : 'running' };
    }
  }
  if (latest?.state === 'failed' || target?.state === 'failed') return { ...evidence, state: 'failed' };
  if (latest?.state === 'interrupted' || target?.state === 'interrupted') return { ...evidence, state: 'interrupted' };
  if (!invocationId && target?.state === 'withdrawn') return { ...evidence, state: 'cancelled' };
  if (!invocationId && target && ['queued', 'notified'].includes(target.state)) return { ...evidence, state: 'queued' };
  return { ...evidence, state: 'unknown' };
}
