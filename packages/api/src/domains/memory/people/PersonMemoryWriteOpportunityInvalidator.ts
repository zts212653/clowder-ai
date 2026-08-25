import type { CaptureCandidateId, PersonId } from '@cat-cafe/shared';
import type { PersonMemoryStore } from './PersonMemoryStore.js';
import type { WriteOpportunityDeliveryStore } from './WriteOpportunityDeliveryStore.js';
import type {
  WriteOpportunityLineageInvalidationReason,
  WriteOpportunityTerminalLedger,
} from './WriteOpportunityTerminalLedger.js';

export interface PersonMemoryWriteOpportunityInvalidatorDeps {
  store: Pick<PersonMemoryStore, 'getCandidateForOwner' | 'listCandidateIdsForPerson'>;
  terminalLedger: WriteOpportunityTerminalLedger;
  deliveryStore: WriteOpportunityDeliveryStore;
}

/** Resolve candidate IDs before destructive mutation removes the person->candidate index. */
export function listPersonWriteOpportunityCandidates(
  deps: PersonMemoryWriteOpportunityInvalidatorDeps,
  ownerUserId: string,
  personId: PersonId,
): Promise<CaptureCandidateId[]> {
  return deps.store.listCandidateIdsForPerson(ownerUserId, personId);
}

export async function resolvePersonMemoryWriteOpportunityLineages(
  deps: PersonMemoryWriteOpportunityInvalidatorDeps,
  ownerUserId: string,
  candidateIds: readonly CaptureCandidateId[],
): Promise<string[]> {
  const candidates = await Promise.all(
    [...new Set(candidateIds)].map((candidateId) => deps.store.getCandidateForOwner(ownerUserId, candidateId)),
  );
  const lineages = new Set(
    candidates.flatMap((candidate) =>
      candidate?.writeOpportunityLineage ? [candidate.writeOpportunityLineage.dedupeLineage] : [],
    ),
  );
  return [...lineages];
}

export async function invalidateResolvedWriteOpportunityLineages(input: {
  deps: PersonMemoryWriteOpportunityInvalidatorDeps;
  ownerUserId: string;
  dedupeLineages: readonly string[];
  reason: WriteOpportunityLineageInvalidationReason;
  recordedAt: number;
}): Promise<void> {
  for (const dedupeLineage of new Set(input.dedupeLineages)) {
    await input.deps.terminalLedger.recordInvalidated({
      ownerUserId: input.ownerUserId,
      dedupeLineage,
      reason: input.reason,
      recordedAt: input.recordedAt,
    });
    await input.deps.deliveryStore.purgeLineage(input.ownerUserId, dedupeLineage);
  }
}
