import type { EntityProposal } from '@cat-cafe/shared';
import type { IEntityProposalStore } from '../approval-hub/stores/ports/IEntityProposalStore.js';
import type { QueryEntityMatch } from './interfaces.js';
import type { PersonMemoryStore } from './people/PersonMemoryStore.js';
import { normalizeCandidatePhrase } from './proactive-memory-lexical-noise.js';

const ALL_RETAINED_PROPOSALS = Number.MAX_SAFE_INTEGER;

export type ProactiveCandidateRegistryMatch =
  | { kind: 'registered_entity'; ref: string }
  | { kind: 'registered_person'; ref: string }
  | { kind: 'pending_candidate'; producerId: 'F260' | 'F276'; proposalId: string }
  | { kind: 'dormant_candidate'; producerId: 'F260' | 'F276'; proposalId: string }
  | { kind: 'unregistered' }
  | { kind: 'unknown' };

interface ExactEntityRegistryReadPort {
  resolveExactAlias(alias: string, viewerUserId: string): QueryEntityMatch[];
}

interface RegistryResolverDeps {
  entityRegistry: ExactEntityRegistryReadPort;
  entityProposalStore: Pick<IEntityProposalStore, 'listPending' | 'listSettledByUser'>;
  personMemoryStore: Pick<
    PersonMemoryStore,
    'resolveActivePersonByAlias' | 'resolvePendingCandidateBySubject' | 'resolveDormantCandidateBySubject'
  >;
}

export interface ResolveProactiveCandidateRegistryInput {
  ownerUserId: string;
  phrase: string;
}

function visibleToOwner(proposal: EntityProposal, ownerUserId: string): boolean {
  return proposal.visibilityScope === 'workspace' || proposal.visibilityScope === `private:${ownerUserId}`;
}

function proposalMatchesSubject(proposal: EntityProposal, normalizedSubject: string): boolean {
  return [proposal.canonicalName, ...proposal.aliases].some(
    (subject) => normalizeCandidatePhrase(subject) === normalizedSubject,
  );
}

function exactProposal(
  proposals: EntityProposal[],
  ownerUserId: string,
  normalizedSubject: string,
  status: 'pending' | 'rejected',
): EntityProposal | null {
  return (
    proposals
      .filter(
        (proposal) =>
          proposal.ownerUserId === ownerUserId &&
          proposal.status === status &&
          visibleToOwner(proposal, ownerUserId) &&
          proposalMatchesSubject(proposal, normalizedSubject),
      )
      .sort((left, right) => right.createdAt - left.createdAt || left.proposalId.localeCompare(right.proposalId))[0] ??
    null
  );
}

export class ProactiveCandidateRegistryResolver {
  constructor(private readonly deps: RegistryResolverDeps) {}

  async resolve(input: ResolveProactiveCandidateRegistryInput): Promise<ProactiveCandidateRegistryMatch> {
    const normalizedSubject = normalizeCandidatePhrase(input.phrase);
    if (!normalizedSubject) return { kind: 'unknown' };

    try {
      const registeredEntities = this.deps.entityRegistry
        .resolveExactAlias(input.phrase, input.ownerUserId)
        .sort((left, right) => left.entityId.localeCompare(right.entityId));
      if (registeredEntities[0]) {
        return { kind: 'registered_entity', ref: registeredEntities[0].entityId };
      }

      const person = await this.deps.personMemoryStore.resolveActivePersonByAlias(input.ownerUserId, input.phrase);
      if (person.status === 'ambiguous') return { kind: 'unknown' };
      if (person.status === 'resolved') {
        return { kind: 'registered_person', ref: person.person.personId };
      }

      const entityPending = exactProposal(
        await this.deps.entityProposalStore.listPending(input.ownerUserId, ALL_RETAINED_PROPOSALS),
        input.ownerUserId,
        normalizedSubject,
        'pending',
      );
      if (entityPending) {
        return { kind: 'pending_candidate', producerId: 'F260', proposalId: entityPending.proposalId };
      }

      const personPending = await this.deps.personMemoryStore.resolvePendingCandidateBySubject(
        input.ownerUserId,
        input.phrase,
      );
      if (personPending) {
        return { kind: 'pending_candidate', producerId: 'F276', proposalId: personPending.candidateId };
      }

      const entityRejected = exactProposal(
        await this.deps.entityProposalStore.listSettledByUser(input.ownerUserId, ALL_RETAINED_PROPOSALS),
        input.ownerUserId,
        normalizedSubject,
        'rejected',
      );
      if (entityRejected) {
        return {
          kind: 'dormant_candidate',
          producerId: 'F260',
          proposalId: entityRejected.proposalId,
        };
      }

      const personDormant = await this.deps.personMemoryStore.resolveDormantCandidateBySubject(
        input.ownerUserId,
        input.phrase,
      );
      if (personDormant) {
        return {
          kind: 'dormant_candidate',
          producerId: 'F276',
          proposalId: personDormant.candidateId,
        };
      }
      return { kind: 'unregistered' };
    } catch {
      return { kind: 'unknown' };
    }
  }
}
