import type { DispatchProposal } from '@cat-cafe/shared';
import {
  computeLegacyNegativeAuthorizationKey,
  computeNegativeAuthorizationKey,
  type DispatchLegacyNegativeAuthorizationLookup,
  type DispatchNegativeAuthorizationBlock,
  type DispatchNegativeAuthorizationLookup,
  isNegativeAuthorizationProposalStatus,
} from './ports/DispatchProposalStoreContracts.js';

/**
 * Test-store projection mirroring Redis' deny-only indexes. It is deliberately
 * separate from proposal state: every lookup revalidates the canonical record.
 */
export class InMemoryDispatchNegativeAuthorizationIndex {
  private readonly exact = new Map<string, Set<string>>();
  private readonly legacy = new Map<string, Set<string>>();

  add(proposal: DispatchProposal): void {
    if (!isNegativeAuthorizationProposalStatus(proposal.status)) return;
    const index = proposal.sourceInvocationId ? this.exact : this.legacy;
    for (const targetCat of new Set(proposal.targetCats)) {
      const key = proposal.sourceInvocationId
        ? computeNegativeAuthorizationKey(
            proposal.ownerUserId,
            proposal.sourceInvocationId,
            proposal.targetThreadId,
            targetCat,
          )
        : computeLegacyNegativeAuthorizationKey(
            proposal.ownerUserId,
            proposal.sourceThreadId,
            proposal.senderCatId,
            proposal.targetThreadId,
            targetCat,
          );
      const proposalIds = index.get(key) ?? new Set<string>();
      proposalIds.add(proposal.proposalId);
      index.set(key, proposalIds);
    }
  }

  remove(proposal: DispatchProposal): void {
    const index = proposal.sourceInvocationId ? this.exact : this.legacy;
    for (const targetCat of new Set(proposal.targetCats)) {
      const key = proposal.sourceInvocationId
        ? computeNegativeAuthorizationKey(
            proposal.ownerUserId,
            proposal.sourceInvocationId,
            proposal.targetThreadId,
            targetCat,
          )
        : computeLegacyNegativeAuthorizationKey(
            proposal.ownerUserId,
            proposal.sourceThreadId,
            proposal.senderCatId,
            proposal.targetThreadId,
            targetCat,
          );
      const proposalIds = index.get(key);
      if (!proposalIds) continue;
      proposalIds.delete(proposal.proposalId);
      if (proposalIds.size === 0) index.delete(key);
    }
  }

  findExact(
    proposals: ReadonlyMap<string, DispatchProposal>,
    input: DispatchNegativeAuthorizationLookup,
  ): DispatchNegativeAuthorizationBlock[] {
    const candidateIds = new Set<string>();
    for (const targetCat of new Set(input.targetCats)) {
      const key = computeNegativeAuthorizationKey(
        input.ownerUserId,
        input.sourceInvocationId,
        input.targetThreadId,
        targetCat,
      );
      for (const proposalId of this.exact.get(key) ?? []) candidateIds.add(proposalId);
    }
    return [...candidateIds]
      .flatMap((proposalId) => {
        const proposal = proposals.get(proposalId);
        if (
          !proposal ||
          proposal.ownerUserId !== input.ownerUserId ||
          proposal.sourceInvocationId !== input.sourceInvocationId ||
          proposal.sourceThreadId !== input.sourceThreadId ||
          proposal.senderCatId !== input.senderCatId ||
          proposal.targetThreadId !== input.targetThreadId ||
          !isNegativeAuthorizationProposalStatus(proposal.status)
        ) {
          return [];
        }
        const targetCats = intersectTargets(proposal.targetCats, input.targetCats);
        return targetCats.length > 0 ? [{ proposalId: proposal.proposalId, status: proposal.status, targetCats }] : [];
      })
      .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  }

  findLegacy(
    proposals: ReadonlyMap<string, DispatchProposal>,
    input: DispatchLegacyNegativeAuthorizationLookup,
  ): DispatchNegativeAuthorizationBlock[] {
    if (input.invocationCreatedAt > input.cutoverAt) return [];
    const candidateIds = new Set<string>();
    for (const targetCat of new Set(input.targetCats)) {
      const key = computeLegacyNegativeAuthorizationKey(
        input.ownerUserId,
        input.sourceThreadId,
        input.senderCatId,
        input.targetThreadId,
        targetCat,
      );
      for (const proposalId of this.legacy.get(key) ?? []) candidateIds.add(proposalId);
    }
    return [...candidateIds]
      .flatMap((proposalId) => {
        const proposal = proposals.get(proposalId);
        if (
          !proposal ||
          proposal.sourceInvocationId ||
          proposal.ownerUserId !== input.ownerUserId ||
          proposal.sourceThreadId !== input.sourceThreadId ||
          proposal.senderCatId !== input.senderCatId ||
          proposal.targetThreadId !== input.targetThreadId ||
          !isNegativeAuthorizationProposalStatus(proposal.status)
        ) {
          return [];
        }
        const targetCats = intersectTargets(proposal.targetCats, input.targetCats);
        return targetCats.length > 0 ? [{ proposalId: proposal.proposalId, status: proposal.status, targetCats }] : [];
      })
      .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  }

  rebuild(proposals: ReadonlyMap<string, DispatchProposal>): { exactIndexed: number; legacyIndexed: number } {
    this.exact.clear();
    this.legacy.clear();
    let exactIndexed = 0;
    let legacyIndexed = 0;
    for (const proposal of proposals.values()) {
      if (!isNegativeAuthorizationProposalStatus(proposal.status)) continue;
      this.add(proposal);
      if (proposal.sourceInvocationId) exactIndexed += 1;
      else legacyIndexed += 1;
    }
    return { exactIndexed, legacyIndexed };
  }
}

function intersectTargets(proposalTargets: readonly string[], carrierTargets: readonly string[]): string[] {
  return [...new Set(proposalTargets.filter((targetCat) => carrierTargets.includes(targetCat)))];
}
