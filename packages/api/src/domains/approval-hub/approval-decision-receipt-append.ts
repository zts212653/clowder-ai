import type { ApprovalDecisionReceiptV1 } from '@cat-cafe/shared';
import { projectLifecycleAppendCapability } from '../cats/services/agents/invocation/lifecycle-append-projection.js';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';

export type ReceiptAppendTracker = Parameters<typeof projectLifecycleAppendCapability>[0]['invocationTracker'];

export interface ReceiptAppendLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  info?(fields: Record<string, unknown>, message: string): void;
}

/** One best-effort supplement to a durable receipt, never Queue admission or a wake. */
export async function appendDecisionReceiptToActiveRun(input: {
  readonly ownerUserId: string;
  readonly receipt: ApprovalDecisionReceiptV1;
  readonly message: StoredMessage;
  readonly invocationTracker: ReceiptAppendTracker;
  readonly logger: ReceiptAppendLogger;
}): Promise<void> {
  const { receipt, message, invocationTracker, logger, ownerUserId } = input;
  const threadId = receipt.approvalCardRef.threadId;
  const targetId = receipt.requesterCatId;
  const identity = { userId: ownerUserId, threadId, targetId, messageId: message.id };
  try {
    if (message.userId !== ownerUserId || message.threadId !== threadId) return;
    const activeRun = invocationTracker.getActiveSlots(threadId).find((slot) => slot.catId === targetId)?.activeRun;
    const capability = projectLifecycleAppendCapability({
      threadId,
      userId: ownerUserId,
      targetId,
      activeRun,
      invocationTracker,
    });
    if (!capability.available) return;
    // Capture once. A replacement may refuse this exact handoff; it never becomes
    // an opportunity to select a newer run or enqueue another invocation.
    const expected = capability.capability.expectedRun;
    const dispatcher = invocationTracker.getAgentClientActiveRunDispatcher?.(threadId, targetId);
    const current = invocationTracker.getActiveSlots(threadId).find((slot) => slot.catId === targetId)?.activeRun;
    if (
      !dispatcher?.capabilities.append ||
      dispatcher.invocationId !== expected.invocationId ||
      current?.threadId !== threadId ||
      current.targetId !== targetId ||
      current.invocationId !== expected.invocationId ||
      current.responseMessageId !== expected.responseMessageId ||
      invocationTracker.getUserId(threadId, targetId) !== ownerUserId
    )
      return;
    const evidence = {
      ...identity,
      invocationId: expected.invocationId,
      responseMessageId: expected.responseMessageId,
      provider: dispatcher.handle.provider,
      carrier: dispatcher.handle.carrier,
      nativeThreadId: dispatcher.handle.threadId,
      nativeTurnId: dispatcher.handle.turnId,
      deliveryId: `approval-decision:${message.id}:${expected.invocationId}`,
    };
    const result = await dispatcher.dispatch(
      {
        text: message.content,
        messageIds: [message.id],
        deliveryId: evidence.deliveryId,
        ...(dispatcher.capabilities.inputReadReceipt
          ? {
              onInputRead: async () => {
                logger.info?.({ ...evidence, phase: 'read' }, 'Approval decision receipt consumed by its exact run');
              },
            }
          : {}),
      },
      { force: false, expectedInvocationId: expected.invocationId },
    );
    logger.info?.(
      {
        ...evidence,
        phase: result.accepted ? 'accepted' : 'refused',
        ...(!result.accepted ? { reason: result.reason } : {}),
      },
      'Approval decision receipt live Append attempted; durable receipt retained',
    );
  } catch (err) {
    logger.warn({ ...identity, err }, 'Approval decision receipt live Append failed; durable receipt retained');
  }
}
