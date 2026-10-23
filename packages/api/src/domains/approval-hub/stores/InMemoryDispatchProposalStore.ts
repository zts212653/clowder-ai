import type { ApprovalEnvelope, ApprovalPublication, DispatchProposal } from '@cat-cafe/shared';
import {
  assertApprovalEnvelopeIdentity,
  commitApprovalEnvelope,
  deriveDispatchProposalSourceInvocationId,
} from '@cat-cafe/shared';
import { type OwnerAuthProvenance, requireOwnerAuthProvenance } from '../../cats/services/owner-auth-provenance.js';
import { InMemoryDispatchNegativeAuthorizationIndex } from './InMemoryDispatchNegativeAuthorizationIndex.js';
import {
  type CreateDispatchProposalInput,
  type CreateDispatchProposalResult,
  computeLineageKey,
  type DispatchCanonicalAdmissionBlock,
  type DispatchCanonicalAdmissionLookup,
  type DispatchLegacyNegativeAuthorizationLookup,
  type DispatchNegativeAuthorizationBlock,
  type DispatchNegativeAuthorizationLookup,
  isCanonicalAdmissionProposalStatus,
  tryCanonicalizeDispatchAdmissionSubjectRef,
  tryComputeDispatchCanonicalActionKey,
} from './ports/DispatchProposalStoreContracts.js';
import type { IDispatchProposalStore } from './ports/DispatchProposalStorePort.js';

/** Fast unit-test implementation; production uses RedisDispatchProposalStore. */
export class InMemoryDispatchProposalStore implements IDispatchProposalStore {
  private readonly proposals = new Map<string, DispatchProposal>();
  private readonly lineageIndex = new Map<string, string>();
  private readonly negativeAuthorization = new InMemoryDispatchNegativeAuthorizationIndex();
  private readonly predecessorCustody = new Map<string, string>();
  private readonly deliveryRollbackCustody = new Map<string, Set<string>>();
  private readonly approvalOwnerAuthProvenance = new Map<string, OwnerAuthProvenance>();
  private legacyCutoverAt: number | undefined;
  private legacyRebuildCompleted = false;

  async create(input: CreateDispatchProposalInput): Promise<CreateDispatchProposalResult> {
    const now = input.createdAt;
    const sourceInvocationId = deriveDispatchProposalSourceInvocationId(input);
    const proposal: DispatchProposal = {
      ...input,
      ...(sourceInvocationId ? { sourceInvocationId } : {}),
      effectClass: 'assign_work',
      status: 'pending',
      publication: { state: 'staged', stagedAt: now },
    };
    const lineage = computeLineageKey(input.sourceThreadId, input.targetThreadId, input.senderCatId);
    const supersededProposals: DispatchProposal[] = [];
    const existingId = this.lineageIndex.get(lineage);
    if (existingId) {
      const existing = this.proposals.get(existingId);
      if (existing?.status === 'pending') {
        if (existing.publication?.state === 'staged') return { proposal: { ...existing }, supersededProposals: [] };
        existing.status = 'superseded';
        existing.supersededBy = input.proposalId;
        existing.supersededAt = now;
        supersededProposals.push({ ...existing });
      }
    }

    this.proposals.set(input.proposalId, proposal);
    this.negativeAuthorization.add(proposal);
    this.approvalOwnerAuthProvenance.delete(input.proposalId);
    this.lineageIndex.set(lineage, input.proposalId);
    const directPredecessor = supersededProposals.at(-1);
    if (directPredecessor) this.predecessorCustody.set(input.proposalId, directPredecessor.proposalId);
    return { proposal: { ...proposal }, supersededProposals };
  }

  async get(proposalId: string): Promise<DispatchProposal | null> {
    const proposal = this.proposals.get(proposalId);
    return proposal ? { ...proposal } : null;
  }

  async listPendingByUser(userId: string): Promise<DispatchProposal[]> {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.ownerUserId === userId && proposal.status === 'pending')
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async approve(
    proposalId: string,
    userId: string,
    ownerAuthProvenance: OwnerAuthProvenance = 'unknown',
  ): Promise<DispatchProposal | null> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    const provenance = requireOwnerAuthProvenance(ownerAuthProvenance);
    proposal.status = 'approved';
    proposal.decidedAt = Date.now();
    proposal.decidedBy = userId;
    this.negativeAuthorization.remove(proposal);
    this.approvalOwnerAuthProvenance.set(proposalId, provenance);
    return { ...proposal };
  }

  async getApprovalOwnerAuthProvenance(proposalId: string): Promise<OwnerAuthProvenance | undefined> {
    return this.approvalOwnerAuthProvenance.get(proposalId);
  }

  async recordDelivery(proposalId: string, deliveredMessageId: string): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (proposal) proposal.deliveredMessageId = deliveredMessageId;
  }

  async revertToPending(proposalId: string): Promise<DispatchProposal | null> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approved') return null;
    const lineage = computeLineageKey(proposal.sourceThreadId, proposal.targetThreadId, proposal.senderCatId);
    const currentHolder = this.lineageIndex.get(lineage);
    this.approvalOwnerAuthProvenance.delete(proposalId);
    if (currentHolder && currentHolder !== proposalId) {
      const holder = this.proposals.get(currentHolder);
      if (holder?.status === 'pending' && holder.publication?.state === 'staged') {
        const predecessors = this.deliveryRollbackCustody.get(currentHolder) ?? new Set<string>();
        predecessors.add(proposalId);
        this.deliveryRollbackCustody.set(currentHolder, predecessors);
      }
      proposal.status = 'superseded';
      proposal.supersededBy = currentHolder;
      proposal.supersededAt = Date.now();
      proposal.decidedAt = undefined;
      proposal.decidedBy = undefined;
      this.negativeAuthorization.add(proposal);
      return null;
    }

    proposal.status = 'pending';
    proposal.decidedAt = undefined;
    proposal.decidedBy = undefined;
    this.negativeAuthorization.add(proposal);
    this.lineageIndex.set(lineage, proposalId);
    return { ...proposal };
  }

  async reject(proposalId: string, userId: string): Promise<DispatchProposal | null> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'rejected';
    proposal.decidedAt = Date.now();
    proposal.decidedBy = userId;
    return { ...proposal };
  }

  async findByClientMessageId(clientMessageId: string, sourceThreadId: string): Promise<DispatchProposal | null> {
    for (const proposal of this.proposals.values()) {
      if (proposal.clientMessageId === clientMessageId && proposal.sourceThreadId === sourceThreadId)
        return { ...proposal };
    }
    return null;
  }

  async findNegativeAuthorizationBlocks(
    input: DispatchNegativeAuthorizationLookup,
  ): Promise<DispatchNegativeAuthorizationBlock[]> {
    return this.negativeAuthorization.findExact(this.proposals, input);
  }

  async findCanonicalAdmissionBlocks(
    input: DispatchCanonicalAdmissionLookup,
  ): Promise<DispatchCanonicalAdmissionBlock[]> {
    if (!input.canonicalActionKey && !input.canonicalSubjectRef) return [];
    return [...this.proposals.values()]
      .flatMap((proposal) => {
        if (
          proposal.ownerUserId !== input.ownerUserId ||
          !proposal.proposedAction ||
          !isCanonicalAdmissionProposalStatus(proposal.status)
        ) {
          return [];
        }
        const canonicalActionKey = tryComputeDispatchCanonicalActionKey(proposal.ownerUserId, proposal.proposedAction);
        if (!canonicalActionKey) return [];
        const matches = input.canonicalActionKey
          ? canonicalActionKey === input.canonicalActionKey
          : tryCanonicalizeDispatchAdmissionSubjectRef(proposal.proposedAction.subjectRef) ===
            input.canonicalSubjectRef;
        return matches ? [{ proposalId: proposal.proposalId, status: proposal.status }] : [];
      })
      .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  }

  async findLegacyNegativeAuthorizationBlocks(
    input: DispatchLegacyNegativeAuthorizationLookup,
  ): Promise<DispatchNegativeAuthorizationBlock[]> {
    return this.negativeAuthorization.findLegacy(this.proposals, input);
  }

  async getNegativeAuthorizationLegacyCutoverAt(): Promise<number | undefined> {
    return this.legacyCutoverAt;
  }

  async establishNegativeAuthorizationLegacyCutoverAt(cutoverAt: number): Promise<number> {
    if (!Number.isFinite(cutoverAt) || cutoverAt <= 0)
      throw new Error('negative authorization cutoverAt must be positive');
    if (!this.legacyRebuildCompleted) {
      throw new Error('negative authorization legacy cutover requires a completed canonical index rebuild');
    }
    if (this.legacyCutoverAt === undefined) this.legacyCutoverAt = cutoverAt;
    return this.legacyCutoverAt;
  }

  async rebuildNegativeAuthorizationIndexes(): Promise<{ exactIndexed: number; legacyIndexed: number }> {
    this.legacyRebuildCompleted = true;
    return this.negativeAuthorization.rebuild(this.proposals);
  }

  async listSettledByUser(userId: string, limit: number): Promise<DispatchProposal[]> {
    return [...this.proposals.values()]
      .filter(
        (proposal) =>
          proposal.ownerUserId === userId && ['approved', 'rejected', 'superseded'].includes(proposal.status),
      )
      .sort((left, right) => (right.supersededAt ?? right.decidedAt ?? 0) - (left.supersededAt ?? left.decidedAt ?? 0))
      .slice(0, limit)
      .map((proposal) => ({ ...proposal }));
  }

  async getPublication(proposalId: string): Promise<ApprovalPublication | null> {
    return this.proposals.get(proposalId)?.publication ?? null;
  }

  async commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    assertApprovalEnvelopeIdentity(envelope, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.senderCatId,
      createdAt: proposal.createdAt,
    });
    proposal.publication = commitApprovalEnvelope(proposal.publication, envelope);
  }

  async abortStaged(proposalId: string, _reason: string): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.publication?.state !== 'staged') return;
    const lineage = computeLineageKey(proposal.sourceThreadId, proposal.targetThreadId, proposal.senderCatId);
    const holderId = this.lineageIndex.get(lineage);
    if (holderId && holderId !== proposalId) return;
    const predecessorId = this.predecessorCustody.get(proposalId);
    const predecessor = (id: string) => {
      const candidate = this.proposals.get(id);
      return candidate?.status === 'superseded' && candidate.supersededBy === proposalId ? candidate : undefined;
    };
    const deliveryPredecessors = [...(this.deliveryRollbackCustody.get(proposalId) ?? [])]
      .flatMap((id) => predecessor(id) ?? [])
      .sort((left, right) => right.createdAt - left.createdAt);
    const restored = (predecessorId ? predecessor(predecessorId) : undefined) ?? deliveryPredecessors[0];

    this.negativeAuthorization.remove(proposal);
    this.proposals.delete(proposalId);
    this.approvalOwnerAuthProvenance.delete(proposalId);
    this.predecessorCustody.delete(proposalId);
    this.deliveryRollbackCustody.delete(proposalId);
    this.lineageIndex.delete(lineage);
    if (!restored) return;
    for (const candidate of deliveryPredecessors) {
      if (candidate.proposalId !== restored.proposalId) candidate.supersededBy = restored.proposalId;
    }
    restored.status = 'pending';
    restored.supersededBy = undefined;
    restored.supersededAt = undefined;
    this.lineageIndex.set(lineage, restored.proposalId);
  }
}
