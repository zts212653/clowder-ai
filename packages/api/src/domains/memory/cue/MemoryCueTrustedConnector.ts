import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { MemoryCueOpportunitySeed } from './MemoryCueInvocationPromptService.js';
import { deliveryDecisionSeedFromTrustedCarrier } from './MemoryCueTrustedCarrier.js';

export async function readTrustedConnectorMemoryCueSeeds(input: {
  entrySource: string;
  messageId: string | null;
  expectedThreadId: string;
  expectedUserId: string;
  messageStore: Pick<IMessageStore, 'getById'>;
}): Promise<MemoryCueOpportunitySeed[]> {
  if (input.entrySource !== 'connector' || !input.messageId) return [];
  const stored = await Promise.resolve(input.messageStore.getById(input.messageId));
  if (
    !stored ||
    stored.id !== input.messageId ||
    stored.threadId !== input.expectedThreadId ||
    stored.userId !== input.expectedUserId ||
    stored.catId !== null ||
    stored.source?.connector !== 'github-ci' ||
    stored.deletedAt !== undefined ||
    stored._tombstone
  ) {
    return [];
  }
  const seed = deliveryDecisionSeedFromTrustedCarrier(stored.extra?.memoryCue?.deliveryDecision, stored.id);
  return seed ? [seed] : [];
}
