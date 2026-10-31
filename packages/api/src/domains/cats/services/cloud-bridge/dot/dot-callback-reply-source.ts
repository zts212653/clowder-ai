import { readQueueTargetExecution } from '../../agents/invocation/queue-ledger/QueueTargetExecutionView.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { TurnExecutionRecord } from '../../stores/ports/TurnExecutionStore.js';
import { DOT_CAT_ID } from './dot-connection-state.js';

/** Bind an explicit reply to its admitted Ask, preserving the execution's original trigger. */
export async function resolveDotCallbackReplySource(input: {
  triggerMessageId: string | undefined;
  replyTo: string | undefined;
  execution: TurnExecutionRecord | null;
  messages: Pick<IMessageStore, 'getById'>;
}): Promise<string | undefined> {
  const { triggerMessageId, replyTo, execution, messages } = input;
  if (!replyTo || replyTo === triggerMessageId || !execution) return triggerMessageId;
  const root = await messages.getById(replyTo);
  if (
    execution.status !== 'running' ||
    !root?.extra?.dotAsk ||
    root.catId !== DOT_CAT_ID ||
    root.threadId !== execution.threadId ||
    root.userId !== execution.userId ||
    !root.extra.dotAsk.recipientCatIds.includes(execution.catId) ||
    root.deletedAt ||
    root.recall ||
    root._tombstone
  )
    return triggerMessageId;
  const admitted = await readQueueTargetExecution(messages, undefined, root, execution.catId);
  const dispatch = root.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === execution.catId);
  return admitted?.kind === 'response' &&
    admitted.response.status === 'processing' &&
    admitted.response.invocationId === execution.invocationId &&
    dispatch?.dispatchedAt !== undefined &&
    dispatch.dispatchedAt >= execution.startedAt
    ? root.id
    : triggerMessageId;
}
