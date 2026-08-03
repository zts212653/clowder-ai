import type { QueueSourceResponseConsumptionWitness } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';

export interface QueueSourceResponseEvidence {
  sourceMessageId: string;
  witness: QueueSourceResponseConsumptionWitness;
}

function hasUserVisibleOutput(message: StoredMessage): boolean {
  return message.content.trim().length > 0 || (message.contentBlocks?.length ?? 0) > 0;
}

function hasExactInvocation(message: StoredMessage, invocationId: string): boolean {
  const stream = message.extra?.stream;
  return stream?.turnInvocationId === invocationId || stream?.invocationId === invocationId;
}

/**
 * Resolve only durable, user-visible output records which explicitly bind an
 * exact Queue source. Prompt exposure and generic tool activity are not
 * consumption evidence and intentionally do not enter this projection.
 */
export async function resolveQueueSourceResponseEvidence(input: {
  messageStore: IMessageStore;
  threadId: string;
  userId: string;
  catId: string;
  invocationId: string;
  sourceMessageIds: readonly string[];
}): Promise<QueueSourceResponseEvidence[]> {
  const readThread = input.messageStore.getByThreadAfter?.bind(input.messageStore);
  if (!readThread || input.sourceMessageIds.length === 0) return [];
  const sourceMessageIds = new Set(input.sourceMessageIds);
  const outputIdsBySource = new Map<string, string[]>();
  const messages = await readThread(input.threadId, undefined, undefined, input.userId);
  for (const message of messages) {
    if (
      message.catId !== input.catId ||
      message.deliveryStatus === 'canceled' ||
      !hasExactInvocation(message, input.invocationId) ||
      !hasUserVisibleOutput(message)
    ) {
      continue;
    }
    const refs = new Set(
      [message.replyTo, message.extra?.causal?.triggerMessageId].filter(
        (messageId): messageId is string => typeof messageId === 'string' && sourceMessageIds.has(messageId),
      ),
    );
    for (const sourceMessageId of refs) {
      const outputIds = outputIdsBySource.get(sourceMessageId) ?? [];
      if (!outputIds.includes(message.id)) outputIds.push(message.id);
      outputIdsBySource.set(sourceMessageId, outputIds);
    }
  }
  return [...outputIdsBySource].map(([sourceMessageId, outputMessageIds]) => ({
    sourceMessageId,
    witness: { kind: 'source_response', outputMessageIds },
  }));
}
