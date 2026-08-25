import type { FastifyBaseLogger } from 'fastify';

export interface CallbackDeliveryDecisionInput {
  canEnqueueA2A: boolean;
  willEnqueueToQueue: boolean;
  messageId: string;
  threadId: string;
  log: Pick<FastifyBaseLogger, 'error' | 'warn'>;
  logContext?: Record<string, unknown>;
  enqueueA2A: () => Promise<{ enqueued: readonly string[]; coalesced?: readonly string[] }>;
  markDelivered?: (deliveredAt: number) => Promise<unknown> | unknown;
  preserveQueuedOnEnqueueFailure?: boolean;
  zeroEnqueuedWarnMessage: string;
  enqueueFailureMessage: string;
}

export interface CallbackDeliveryDecision {
  shouldBroadcastNow: boolean;
  enqueued: readonly string[];
  enqueueAttempted: boolean;
  enqueueFailed: boolean;
}

async function recoverQueuedMessage(input: CallbackDeliveryDecisionInput, warnMessage: string): Promise<void> {
  try {
    await input.markDelivered?.(Date.now());
  } catch (err) {
    input.log.warn({ ...input.logContext, err, messageId: input.messageId, threadId: input.threadId }, warnMessage);
  }
}

function shouldPreserveQueuedMessage(input: CallbackDeliveryDecisionInput): boolean {
  return Boolean(input.willEnqueueToQueue && input.preserveQueuedOnEnqueueFailure);
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
      const preserveQueued = shouldPreserveQueuedMessage(input);
      if (input.willEnqueueToQueue && !preserveQueued) {
        await recoverQueuedMessage(input, input.zeroEnqueuedWarnMessage);
      }
      return {
        shouldBroadcastNow: !preserveQueued,
        enqueued: [],
        enqueueAttempted: false,
        enqueueFailed: preserveQueued,
      };
    }

    try {
      const a2aResult = await input.enqueueA2A();
      // F216 AC-D6: coalesced targets are handled (content merged into existing entry).
      // Only warn/recover when truly nothing was handled (enqueued=0 AND coalesced=0).
      const anyHandled = a2aResult.enqueued.length > 0 || (a2aResult.coalesced?.length ?? 0) > 0;
      if (input.willEnqueueToQueue && !anyHandled) {
        if (input.preserveQueuedOnEnqueueFailure) {
          return {
            shouldBroadcastNow: false,
            enqueued: a2aResult.enqueued,
            enqueueAttempted: true,
            enqueueFailed: true,
          };
        }
        await recoverQueuedMessage(input, input.zeroEnqueuedWarnMessage);
        return {
          shouldBroadcastNow: true,
          enqueued: a2aResult.enqueued,
          enqueueAttempted: true,
          enqueueFailed: false,
        };
      }
      return {
        shouldBroadcastNow: !input.willEnqueueToQueue,
        enqueued: a2aResult.enqueued,
        enqueueAttempted: true,
        enqueueFailed: false,
      };
    } catch (err) {
      input.log.error(
        { ...input.logContext, err, messageId: input.messageId, threadId: input.threadId },
        input.enqueueFailureMessage,
      );
      const preserveQueued = shouldPreserveQueuedMessage(input);
      if (input.willEnqueueToQueue && !preserveQueued) {
        await recoverQueuedMessage(input, input.enqueueFailureMessage);
      }
      return {
        shouldBroadcastNow: !preserveQueued,
        enqueued: [],
        enqueueAttempted: true,
        enqueueFailed: true,
      };
    }
  }
}
