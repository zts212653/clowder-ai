import { createHash } from 'node:crypto';
import type { ContentModificationRecord, ContentModificationRequestView } from '@cat-cafe/shared';
import {
  type QueueTargetExecutionReadPort,
  readQueueTargetExecution,
} from '../../cats/services/agents/invocation/queue-ledger/QueueTargetExecutionView.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../../cats/services/stores/ports/TurnExecutionStore.js';

/** A queue carrier, a started executor and a returned result are separate owner facts. */
export async function readModificationExecution(
  deps: {
    messages: Pick<IMessageStore, 'getByIdempotencyKey' | 'getById'>;
    queue?: QueueTargetExecutionReadPort;
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
  const execution = await readQueueTargetExecution(deps.messages, deps.queue, message, record.payload.targetCatId);
  const invocationId = execution?.kind === 'response' ? execution.response.invocationId : undefined;
  const queueEntryId = execution?.kind === 'pending' ? execution.entry.id : undefined;
  const evidence = {
    messageId: message.id,
    ...(queueEntryId ? { queueEntryId } : {}),
    targetCatId: record.payload.targetCatId,
    ...(invocationId ? { invocationId } : {}),
    observedAt:
      execution?.kind === 'response'
        ? (execution.response.completedAt ?? execution.response.startedAt)
        : message.timestamp,
    evidenceRef:
      execution?.kind === 'response' ? `message:${execution.message.id}#response` : `message:${message.id}#input`,
  };
  if (invocationId && deps.turnExecutions) {
    const invocation = await deps.turnExecutions.get(invocationId);
    if (
      !invocation ||
      invocation.invocationId !== invocationId ||
      !invocation.parentInvocationId ||
      invocation.parentInvocationId === invocationId ||
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
        return {
          ...fact,
          state: message.deliveryStatus === 'canceled' || message.recall ? 'withdrawn_running' : 'running',
        };
    }
  }
  if (!invocationId && message.deliveryStatus === 'canceled') return { ...evidence, state: 'cancelled' };
  if (execution?.kind === 'pending') return { ...evidence, state: 'queued' };
  return { ...evidence, state: 'unknown' };
}
