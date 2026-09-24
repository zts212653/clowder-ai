import type { FastifyBaseLogger } from 'fastify';

export interface CallbackDeliveryDecisionInput {
  canEnqueueA2A: boolean;
  messageId: string;
  threadId: string;
  log: Pick<FastifyBaseLogger, 'error' | 'warn'>;
  logContext?: Record<string, unknown>;
  enqueueA2A: () => Promise<{ enqueued: readonly string[]; coalesced?: readonly string[] }>;
  enqueueFailureMessage: string;
}

export interface CallbackDeliveryDecision {
  enqueued: readonly string[];
  enqueueAttempted: boolean;
  enqueueFailed: boolean;
}

/**
 * Centralizes callback wake decisions. Agent speech is already public when this
 * runs; Queue admission controls only recipient execution and never publication.
 */
export class MessageDeliveryService {
  static async resolveCallbackDeliveryDecision(
    input: CallbackDeliveryDecisionInput,
  ): Promise<CallbackDeliveryDecision> {
    if (!input.canEnqueueA2A) {
      return {
        enqueued: [],
        enqueueAttempted: false,
        enqueueFailed: false,
      };
    }

    try {
      const a2aResult = await input.enqueueA2A();
      // F216 AC-D6: coalesced targets are handled (content merged into existing entry).
      // Only warn/recover when truly nothing was handled (enqueued=0 AND coalesced=0).
      const anyHandled = a2aResult.enqueued.length > 0 || (a2aResult.coalesced?.length ?? 0) > 0;
      if (!anyHandled) {
        return {
          enqueued: a2aResult.enqueued,
          enqueueAttempted: true,
          enqueueFailed: true,
        };
      }
      return {
        enqueued: a2aResult.enqueued,
        enqueueAttempted: true,
        enqueueFailed: false,
      };
    } catch (err) {
      input.log.error(
        { ...input.logContext, err, messageId: input.messageId, threadId: input.threadId },
        input.enqueueFailureMessage,
      );
      return {
        enqueued: [],
        enqueueAttempted: true,
        enqueueFailed: true,
      };
    }
  }
}
