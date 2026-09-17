import { type CloudBridgeOutboundReceiptV1, createCatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import {
  canQuoteInPublicReply,
  isInternalNonQuotableParent,
  type ResolveReplyParentOptions,
  resolveVisibleReplyParent,
} from '../../stores/visibility.js';

const log = createModuleLogger('cloud-outbound-receipt-provenance');

export async function validateOutboundReceipt(args: {
  messageStore: IMessageStore;
  threadId: string;
  catId: string;
  expectedSourceMessageId: string | undefined;
  expectedDispatchInvocationId: string | undefined;
  receipt: CloudBridgeOutboundReceiptV1;
}): Promise<CloudBridgeOutboundReceiptV1 | undefined> {
  const { receipt } = args;
  if (
    !args.expectedSourceMessageId ||
    receipt.sourceMessageId !== args.expectedSourceMessageId ||
    !args.expectedDispatchInvocationId ||
    receipt.dispatchInvocationId !== args.expectedDispatchInvocationId ||
    receipt.targetCatId !== args.catId
  ) {
    log.warn(
      {
        threadId: args.threadId,
        catId: args.catId,
        sourceMessageId: receipt.sourceMessageId,
        dispatchInvocationId: receipt.dispatchInvocationId,
      },
      'Dropping cloud outbound receipt with mismatched server dispatch context',
    );
    return undefined;
  }
  const source = await resolveReceiptSource(
    args.messageStore,
    receipt.sourceMessageId,
    {
      threadId: args.threadId,
      viewer: { type: 'cat', catId: createCatId(args.catId) },
      publicReply: true,
    },
    receipt.dispatchInvocationId,
  );
  if (!source) return undefined;

  const senderMatches =
    receipt.sourceSender.kind === 'user'
      ? source.catId === null && source.userId === receipt.sourceSender.id
      : source.catId === createCatId(receipt.sourceSender.id);
  if (!senderMatches) return undefined;
  if (receipt.sourceSender.invocationId) {
    const storedInvocationIds = new Set(
      [source.extra?.stream?.turnInvocationId, source.extra?.stream?.invocationId].filter((value): value is string =>
        Boolean(value),
      ),
    );
    if (!storedInvocationIds.has(receipt.sourceSender.invocationId)) return undefined;
  }
  return receipt;
}

/** Validate this dispatch's receipt without publishing queued work to other cats. */
async function resolveReceiptSource(
  store: IMessageStore,
  id: string,
  options: ResolveReplyParentOptions,
  dispatchInvocationId: string,
): Promise<StoredMessage | null> {
  const published = await resolveVisibleReplyParent(store, id, options);
  if (published) return published;

  // A queued user source remains browser-only, but this exact child already read
  // it. The durable exposure is receipt authority, never general reply authority.
  const targetCatId = options.viewer.type === 'cat' ? options.viewer.catId : undefined;
  const queued = await store.getById(id);
  if (
    !queued ||
    queued.threadId !== options.threadId ||
    queued.catId !== null ||
    queued.deliveryStatus !== 'queued' ||
    queued.deletedAt ||
    queued._tombstone ||
    isInternalNonQuotableParent(queued) ||
    queued.userId === 'scheduler' ||
    !canQuoteInPublicReply(queued) ||
    !targetCatId ||
    !queued.queueCustody?.bodyExposures?.some(
      (exposure) => exposure.targetCatId === targetCatId && exposure.invocationId === dispatchInvocationId,
    )
  )
    return null;
  return queued;
}
