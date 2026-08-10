import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { RecallMessageToComposerDraftCoordinatorResult } from '../domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { emitQueueUpdated, enrichQueueEntries } from '../utils/queue-enrichment.js';
import { projectRecallMessage } from './composer-draft-recall-helpers.js';
import type { DerivedTitleSuppression } from './composer-draft-recall-title.js';

type RecalledResult = Extract<RecallMessageToComposerDraftCoordinatorResult, { kind: 'recalled' }>;

interface RecallProjectionContext {
  socketManager: SocketManager;
  messageStore: IMessageStore;
  invocationQueue: InvocationQueue;
  ownerUserId: string;
  threadId: string;
  messageId: string;
  result: RecalledResult;
}

export async function emitRecallProjection(
  context: RecallProjectionContext,
  titleSuppression: DerivedTitleSuppression | null,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    if (titleSuppression) {
      context.socketManager.broadcastToRoom(`thread:${context.threadId}`, 'thread_updated', {
        threadId: context.threadId,
        title: titleSuppression.replacementTitle,
      });
    }
    context.socketManager.broadcastToRoom(`thread:${context.threadId}`, 'message_recalled', {
      messageId: context.messageId,
      threadId: context.threadId,
      verdict: context.result.verdict,
      recall: context.result.message.recall,
    });
    await emitQueueUpdated(
      context.socketManager,
      context.ownerUserId,
      context.threadId,
      context.invocationQueue.list(context.threadId, context.ownerUserId),
      context.messageStore,
      context.result.verdict === 'zero_exposure' ? 'recalled' : 'withdrawn_after_exposure',
    );
  } catch (error) {
    onError(error);
  }
}

export async function buildRecallSuccessResponse(context: RecallProjectionContext) {
  return {
    verdict: context.result.verdict,
    message: projectRecallMessage(context.result.message),
    draft: context.result.draft,
    insertedRange: context.result.insertedRange,
    queue: await enrichQueueEntries(
      context.invocationQueue.list(context.threadId, context.ownerUserId),
      context.messageStore,
    ),
  };
}
