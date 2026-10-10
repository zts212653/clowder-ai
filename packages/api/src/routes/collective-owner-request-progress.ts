import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import { collectiveSourceIdentitySchema } from '@cat-cafe/shared';
import {
  type QueueTargetExecutionReadPort,
  readQueueTargetExecution,
} from '../domains/cats/services/agents/invocation/queue-ledger/QueueTargetExecutionView.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';

type InboxItem = Awaited<ReturnType<CollectiveConnector['listInbox']>>[number];
type OwnerThread = Awaited<ReturnType<IThreadStore['list']>>[number];
type Stage = 'queued' | 'started' | 'ended' | 'failed';

/** Owner-only view of exact private execution; no Thread ID or Queue evidence enters Service. */
export async function ownerRequestExecution(
  item: InboxItem,
  thread: OwnerThread | undefined,
  messages: Pick<IMessageStore, 'getById'>,
  ownerUserId: string,
  connectionId: string,
  queue?: QueueTargetExecutionReadPort,
): Promise<{ stage: Stage } | undefined> {
  const receipt = item.routeReceipt?.kind === 'thread_message' ? item.routeReceipt : undefined;
  const recipient = item.event.recipient?.kind === 'agent' ? item.event.recipient : undefined;
  if (
    !thread ||
    !receipt ||
    !recipient ||
    receipt.catId !== recipient.agentId ||
    recipient.connectionId !== connectionId
  )
    return undefined;
  let message: Awaited<ReturnType<IMessageStore['getById']>>;
  try {
    message = await messages.getById(receipt.messageId);
  } catch {
    return undefined;
  }
  if (!message || message.userId !== ownerUserId || message.threadId !== thread.id) return undefined;
  const source = collectiveSourceIdentitySchema.safeParse(message.source?.meta?.participation);
  if (
    !source.success ||
    source.data.connectionId !== connectionId ||
    source.data.eventId !== item.event.eventId ||
    source.data.catId !== recipient.agentId ||
    message.source?.connector !== 'collective' ||
    message.from?.kind !== 'external' ||
    message.from.connectorId !== 'collective'
  )
    return undefined;
  const execution = await readQueueTargetExecution(messages, queue, message, recipient.agentId);
  if (execution?.kind === 'pending') {
    return execution.entry.execution.executionScope === 'collective-participation' ? { stage: 'queued' } : undefined;
  }
  if (execution?.kind !== 'response') return undefined;
  const status = execution.response.status;
  const stage: Stage = status === 'processing' ? 'started' : status === 'failed' ? 'failed' : 'ended';
  return { stage };
}
