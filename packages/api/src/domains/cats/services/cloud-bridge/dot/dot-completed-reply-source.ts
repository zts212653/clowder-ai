import { createCatId } from '@cat-cafe/shared';
import { readQueueTargetExecution } from '../../agents/invocation/queue-ledger/QueueTargetExecutionView.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import { canViewMessage, isTimelinePublished } from '../../stores/visibility.js';
import { DOT_CAT_ID } from './dot-connection-state.js';

/** Resolve one unambiguous consultation from this canonical response's admitted inputs.
 * Execution origin stays immutable. Callback posts and text/replyTo supply no authority.
 */
export interface DotCompletedReplySourceInput {
  messages: Pick<IMessageStore, 'getById'>;
  responseMessageId: string | undefined;
  invocationId: string | undefined;
  userId: string;
  threadId: string;
  catId: string;
  triggerMessageId: string | undefined;
}
export interface DotCompletedReplySnapshot {
  sourceMessageId: string | undefined;
  inputMessageIds?: readonly string[];
}

export async function readDotCompletedReplySnapshot(
  input: DotCompletedReplySourceInput,
): Promise<DotCompletedReplySnapshot> {
  const { messages, responseMessageId, invocationId, userId, threadId, catId, triggerMessageId } = input;
  if (!responseMessageId || !invocationId) return { sourceMessageId: triggerMessageId };
  const response = await messages.getById(responseMessageId);
  const lifecycle = response?.lifecycle;
  if (
    response?.userId !== userId ||
    response.threadId !== threadId ||
    response.catId !== catId ||
    lifecycle?.kind !== 'response' ||
    lifecycle.status !== 'processing' ||
    lifecycle.targetId !== catId ||
    lifecycle.invocationId !== invocationId
  )
    return { sourceMessageId: triggerMessageId };

  const inputMessageIds = [...lifecycle.inputMessageIds];
  const original = { sourceMessageId: triggerMessageId, inputMessageIds };
  let selected: string | undefined;
  for (const sourceId of new Set(inputMessageIds)) {
    const root = await messages.getById(sourceId);
    if (
      !root?.extra?.dotAsk ||
      root.catId !== DOT_CAT_ID ||
      root.userId !== userId ||
      root.threadId !== threadId ||
      !root.extra.dotAsk.recipientCatIds.includes(catId) ||
      root.deletedAt ||
      root.recall ||
      root._tombstone ||
      root.visibility === 'whisper' ||
      !isTimelinePublished(root) ||
      !canViewMessage(root, { type: 'cat', catId: createCatId(DOT_CAT_ID) })
    )
      continue;
    const admitted = await readQueueTargetExecution(messages, undefined, root, catId);
    const dispatch = root.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === catId);
    if (
      admitted?.kind !== 'response' ||
      admitted.message.id !== responseMessageId ||
      admitted.response.invocationId !== invocationId ||
      dispatch?.dispatchedAt === undefined ||
      dispatch.dispatchedAt < lifecycle.startedAt
    )
      continue;
    // One response has one causal reply source. Never guess among multiple Asks.
    if (selected) return original;
    selected = root.id;
  }
  return { sourceMessageId: selected ?? triggerMessageId, inputMessageIds };
}

export async function resolveDotCompletedReplySource(input: DotCompletedReplySourceInput): Promise<string | undefined> {
  return (await readDotCompletedReplySnapshot(input)).sourceMessageId;
}
