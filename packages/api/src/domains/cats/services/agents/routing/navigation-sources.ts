import { type CatId, isCrossThreadProvenance } from '@cat-cafe/shared';
import { getMessageSpeakerName } from '../../context/ContextAssembler.js';
import { isDisplayOnlySystemMessage } from '../../stores/host-message-policy.js';
import { messageFrom } from '../../stores/message-from.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import {
  canViewMessage,
  isAgentReadableManagedHoldMessage,
  isOwnerVisibleManagedHoldConnector,
  isTimelinePublished,
} from '../../stores/visibility.js';

/** A projection of an exact route input; never handoff or Task authority. */
export interface InvocationSource {
  fromMessageId: string;
  fromSpeakerDisplay: string;
  timestamp: number;
  sourceThreadId?: string;
  sourceMessageId?: string;
}

export function projectInvocationSource(message: StoredMessage): InvocationSource {
  const crossPost = message.extra?.crossPost;
  const crossThread = isCrossThreadProvenance(crossPost?.sourceThreadId, message.threadId);
  return {
    fromMessageId: message.id,
    fromSpeakerDisplay: getMessageSpeakerName(message),
    timestamp: message.timestamp,
    ...(crossThread && crossPost
      ? {
          sourceThreadId: crossPost.sourceThreadId,
          ...(crossPost.sourceMessageId ? { sourceMessageId: crossPost.sourceMessageId } : {}),
        }
      : {}),
  };
}

/** Exact IDs come from the route/Queue. History text and mentions never select a source. */
export async function resolveInvocationSources(
  messageStore: Pick<IMessageStore, 'getById'>,
  messageIds: readonly string[],
  target: { userId: string; threadId: string; catId: CatId; thinkingMode?: 'debug' | 'play' },
): Promise<InvocationSource[]> {
  const viewer =
    target.thinkingMode === 'debug' ? { type: 'user' as const } : { type: 'cat' as const, catId: target.catId };
  const sources = await Promise.all(
    [...new Set(messageIds)].map(async (id) => {
      let message: StoredMessage | null;
      try {
        message = await messageStore.getById(id);
      } catch {
        return null;
      }
      if (!message || message.id !== id || message.threadId !== target.threadId || message.origin === 'briefing')
        return null;
      if (message.deletedAt || message._tombstone || message.recall || message.deliveryStatus === 'canceled')
        return null;
      if (message.userId !== target.userId && !isOwnerVisibleManagedHoldConnector(message, target.userId)) return null;
      if (!isTimelinePublished(message) || !canViewMessage(message, viewer)) return null;
      const from = messageFrom(message);
      if (from.kind === 'system' && isDisplayOnlySystemMessage(message) && !isAgentReadableManagedHoldMessage(message))
        return null;
      if (
        from.kind === 'agent' &&
        from.catId === target.catId &&
        !isCrossThreadProvenance(message.extra?.crossPost?.sourceThreadId, message.threadId)
      )
        return null;
      return projectInvocationSource(message);
    }),
  );
  return sources.filter((source): source is InvocationSource => source !== null);
}
