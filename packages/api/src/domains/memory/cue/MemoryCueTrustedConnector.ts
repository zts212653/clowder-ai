import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { MemoryCueOpportunitySeed } from './MemoryCueInvocationPromptService.js';
import {
  catOwnedSeedSeedFromTrustedCarrier,
  deliveryDecisionSeedFromTrustedCarrier,
} from './MemoryCueTrustedCarrier.js';

export async function readTrustedConnectorMemoryCueSeeds(input: {
  entrySource: string;
  messageId: string | null;
  expectedThreadId: string;
  expectedUserId: string;
  expectedTargetCatIds?: readonly string[];
  messageStore: Pick<IMessageStore, 'getById'>;
}): Promise<MemoryCueOpportunitySeed[]> {
  if (input.entrySource !== 'connector' || !input.messageId) return [];
  const stored = await Promise.resolve(input.messageStore.getById(input.messageId));
  if (
    !stored ||
    stored.id !== input.messageId ||
    stored.threadId !== input.expectedThreadId ||
    stored.catId !== null ||
    stored.deletedAt !== undefined ||
    stored._tombstone
  ) {
    return [];
  }
  if (stored.source?.connector === 'scheduler') {
    if (stored.userId !== 'scheduler' || stored.extra?.scheduler?.hiddenTrigger !== true) return [];
    const seed = catOwnedSeedSeedFromTrustedCarrier(
      stored.extra?.memoryCue?.catOwnedSeed,
      stored.id,
      input.expectedTargetCatIds ?? [],
    );
    return seed ? [seed] : [];
  }
  if (stored.source?.connector !== 'github-ci' || stored.userId !== input.expectedUserId) return [];
  const seed = deliveryDecisionSeedFromTrustedCarrier(stored.extra?.memoryCue?.deliveryDecision, stored.id);
  return seed ? [seed] : [];
}
