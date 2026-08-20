import type { CaptureCandidateId, PersonId } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { PersonMemoryStore } from '../domains/memory/people/PersonMemoryStore.js';
import {
  invalidateResolvedWriteOpportunityLineages,
  listPersonWriteOpportunityCandidates,
  type PersonMemoryWriteOpportunityInvalidatorDeps,
  resolvePersonMemoryWriteOpportunityLineages,
} from '../domains/memory/people/PersonMemoryWriteOpportunityInvalidator.js';
import type { WriteOpportunityDeliveryStore } from '../domains/memory/people/WriteOpportunityDeliveryStore.js';
import type {
  WriteOpportunityLineageInvalidationReason,
  WriteOpportunityTerminalLedger,
} from '../domains/memory/people/WriteOpportunityTerminalLedger.js';

export interface PersonMemoryRouteInvalidationDeps {
  store: Pick<PersonMemoryStore, 'getCandidateForOwner' | 'listCandidateIdsForPerson'>;
  writeOpportunityTerminalLedger?: WriteOpportunityTerminalLedger;
  writeOpportunityDeliveryStore?: WriteOpportunityDeliveryStore;
}

type InvalidationPlan = (applied: boolean) => Promise<boolean>;

async function preparePlan(input: {
  deps: PersonMemoryRouteInvalidationDeps;
  ownerUserId: string;
  candidateIds: readonly CaptureCandidateId[];
  reason: WriteOpportunityLineageInvalidationReason;
  log: FastifyBaseLogger;
}): Promise<InvalidationPlan> {
  if (!input.deps.writeOpportunityTerminalLedger || !input.deps.writeOpportunityDeliveryStore) {
    return async () => true;
  }
  const invalidatorDeps: PersonMemoryWriteOpportunityInvalidatorDeps = {
    store: input.deps.store,
    terminalLedger: input.deps.writeOpportunityTerminalLedger,
    deliveryStore: input.deps.writeOpportunityDeliveryStore,
  };
  const lineages = await resolvePersonMemoryWriteOpportunityLineages(
    invalidatorDeps,
    input.ownerUserId,
    input.candidateIds,
  );
  return async (applied) => {
    if (!applied || lineages.length === 0) return true;
    try {
      await invalidateResolvedWriteOpportunityLineages({
        deps: invalidatorDeps,
        ownerUserId: input.ownerUserId,
        dedupeLineages: lineages,
        reason: input.reason,
        recordedAt: Date.now(),
      });
      return true;
    } catch (error) {
      input.log.warn({ err: error, reason: input.reason }, 'person-memory write-opportunity invalidation failed');
      return false;
    }
  };
}

export async function preparePersonWriteOpportunityInvalidation(input: {
  deps: PersonMemoryRouteInvalidationDeps;
  ownerUserId: string;
  personId: PersonId;
  reason: WriteOpportunityLineageInvalidationReason;
  log: FastifyBaseLogger;
}): Promise<InvalidationPlan> {
  if (!input.deps.writeOpportunityTerminalLedger || !input.deps.writeOpportunityDeliveryStore) {
    return async () => true;
  }
  const candidateIds = await listPersonWriteOpportunityCandidates(
    {
      store: input.deps.store,
      terminalLedger: input.deps.writeOpportunityTerminalLedger,
      deliveryStore: input.deps.writeOpportunityDeliveryStore,
    },
    input.ownerUserId,
    input.personId,
  );
  return preparePlan({ ...input, candidateIds });
}

export function prepareCandidateWriteOpportunityInvalidation(input: {
  deps: PersonMemoryRouteInvalidationDeps;
  ownerUserId: string;
  candidateId: CaptureCandidateId;
  reason: WriteOpportunityLineageInvalidationReason;
  log: FastifyBaseLogger;
}): Promise<InvalidationPlan> {
  return preparePlan({ ...input, candidateIds: [input.candidateId] });
}
