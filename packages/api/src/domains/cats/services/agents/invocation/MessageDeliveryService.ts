import type { FastifyBaseLogger } from 'fastify';

export interface CallbackDeliveryDecisionInput {
  canEnqueueA2A: boolean;
  willEnqueueToQueue: boolean;
  messageId: string;
  threadId: string;
  log: Pick<FastifyBaseLogger, 'error' | 'warn'>;
  logContext?: Record<string, unknown>;
  enqueueA2A: () => Promise<{ enqueued: readonly unknown[] }>;
  markDelivered?: (deliveredAt: number) => Promise<unknown> | unknown;
  zeroEnqueuedWarnMessage: string;
  enqueueFailureMessage: string;
}

export interface CallbackDeliveryDecision {
  shouldBroadcastNow: boolean;
}

async function recoverQueuedMessage(input: CallbackDeliveryDecisionInput, warnMessage: string): Promise<void> {
  try {
    await input.markDelivered?.(Date.now());
  } catch (err) {
    input.log.warn({ ...input.logContext, err, messageId: input.messageId, threadId: input.threadId }, warnMessage);
  }
}

/**
 * Centralizes callback delivery decisions shared by agent-key and invocation
 * callbacks: queued messages must wait for QueueProcessor's messages_delivered
 * event, while enqueue failures/zero-target outcomes fail open to live broadcast.
 */
export class MessageDeliveryService {
  static async resolveCallbackDeliveryDecision(
    input: CallbackDeliveryDecisionInput,
  ): Promise<CallbackDeliveryDecision> {
    if (!input.canEnqueueA2A) {
      if (input.willEnqueueToQueue) {
        await recoverQueuedMessage(input, input.zeroEnqueuedWarnMessage);
      }
      return { shouldBroadcastNow: true };
    }

    let messageStaysQueued = input.willEnqueueToQueue;
    try {
      const a2aResult = await input.enqueueA2A();
      if (input.willEnqueueToQueue && a2aResult.enqueued.length === 0) {
        await recoverQueuedMessage(input, input.zeroEnqueuedWarnMessage);
        messageStaysQueued = false;
      }
    } catch (err) {
      input.log.error(
        { ...input.logContext, err, messageId: input.messageId, threadId: input.threadId },
        input.enqueueFailureMessage,
      );
      if (input.willEnqueueToQueue) {
        await recoverQueuedMessage(input, input.enqueueFailureMessage);
      }
      messageStaysQueued = false;
    }

    return { shouldBroadcastNow: !messageStaysQueued };
  }
}
