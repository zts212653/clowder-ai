import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import { collectiveSourceIdentitySchema } from '@cat-cafe/shared';
import type { IMessageStore, QueuedMessageCustody } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';

type InboxItem = Awaited<ReturnType<CollectiveConnector['listInbox']>>[number];
type OwnerThread = Awaited<ReturnType<IThreadStore['list']>>[number];
type Stage = 'queued' | 'started' | 'ended' | 'failed';

function stageFor(custody: QueuedMessageCustody, catId: string): Stage {
  if (custody.targetOutcomeByCatId?.[catId] || custody.handledByCatIds.some((id) => id === catId)) return 'ended';
  if (custody.failedByCatIds.some((id) => id === catId)) return 'failed';
  if (
    custody.seenByCatIds.some((id) => id === catId) ||
    custody.bodyExposures?.some((exposure) => exposure.targetCatId === catId)
  )
    return 'started';
  return 'queued';
}

/** Owner-only view of exact private execution; no Thread ID or custody enters Service. */
export async function ownerRequestExecution(
  item: InboxItem,
  thread: OwnerThread | undefined,
  messages: Pick<IMessageStore, 'getById'>,
  ownerUserId: string,
  connectionId: string,
): Promise<{ stage: Stage } | undefined> {
  const receipt = item.routeReceipt?.kind === 'thread_message' ? item.routeReceipt : undefined;
  const recipient = item.event.recipient?.kind === 'agent' ? item.event.recipient : undefined;
  if (!thread || !receipt || !recipient || receipt.catId !== recipient.agentId) return undefined;
  let message: Awaited<ReturnType<IMessageStore['getById']>>;
  try {
    message = await messages.getById(receipt.messageId);
  } catch {
    return undefined;
  }
  if (!message || message.userId !== ownerUserId || message.threadId !== thread.id) return undefined;
  const source = collectiveSourceIdentitySchema.safeParse(message.source?.meta?.participation);
  const custody = message.queueCustody;
  if (
    !source.success ||
    source.data.connectionId !== connectionId ||
    source.data.eventId !== item.event.eventId ||
    source.data.catId !== recipient.agentId ||
    custody?.executionScope !== 'collective-participation' ||
    !custody.allTargetCats.some((id) => id === recipient.agentId)
  )
    return undefined;
  return { stage: stageFor(custody, recipient.agentId) };
}
