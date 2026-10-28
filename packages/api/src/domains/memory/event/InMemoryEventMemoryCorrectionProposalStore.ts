import type { ApprovalEnvelope, ApprovalPublication, EventMemoryCorrectionProposal } from '@cat-cafe/shared';
import { assertApprovalEnvelopeIdentity, commitApprovalEnvelope } from '@cat-cafe/shared';
import { InMemorySettledIndex } from '../../../utils/in-memory-settled-index.js';
import type { SettledHistoryPageOptions, SettledHistorySourcePage } from '../../../utils/settled-history-page.js';
import type {
  CreateEventMemoryCorrectionProposalInput,
  EventMemoryCorrectionProposalStore,
} from './EventMemoryCorrectionProposalStore.js';

const DEFAULT_LIST_LIMIT = 100;

export class InMemoryEventMemoryCorrectionProposalStore implements EventMemoryCorrectionProposalStore {
  private readonly historyIndex = new InMemorySettledIndex();

  /** Keep only derived ordering refs; original snapshots and mutation semantics remain unchanged. */
  private indexedSnapshot(record: EventMemoryCorrectionProposal): EventMemoryCorrectionProposal {
    this.historyIndex.update(
      record.ownerUserId,
      record.proposalId,
      ['approved', 'rejected'].includes(record.status) ? (record.approvedAt ?? record.rejectedAt ?? 0) : null,
    );
    return clone(record);
  }

  async listSettledPage(
    owner: string,
    options: SettledHistoryPageOptions,
  ): Promise<SettledHistorySourcePage<EventMemoryCorrectionProposal>> {
    return this.historyIndex.page(owner, options, async (id) => {
      const record = this.proposals.get(id);
      return record && record.ownerUserId === owner && ['approved', 'rejected'].includes(record.status)
        ? this.indexedSnapshot(record)
        : null;
    });
  }

  private readonly proposals = new Map<string, EventMemoryCorrectionProposal>();
  private readonly dedup = new Map<string, string>();

  async create(input: CreateEventMemoryCorrectionProposalInput): Promise<EventMemoryCorrectionProposal> {
    const existing = this.proposals.get(input.proposalId);
    if (existing) return this.indexedSnapshot(existing);
    const createdAt = Date.now();
    const proposal: EventMemoryCorrectionProposal = {
      ...structuredClone(input),
      status: 'pending',
      createdAt,
      publication: { state: 'staged', stagedAt: createdAt },
    };
    this.proposals.set(proposal.proposalId, proposal);
    return this.indexedSnapshot(proposal);
  }

  async get(proposalId: string): Promise<EventMemoryCorrectionProposal | null> {
    const proposal = this.proposals.get(proposalId);
    return proposal ? this.indexedSnapshot(proposal) : null;
  }

  async listActionable(ownerUserId: string, limit = DEFAULT_LIST_LIMIT): Promise<EventMemoryCorrectionProposal[]> {
    return this.collect(
      (proposal) =>
        proposal.ownerUserId === ownerUserId && (proposal.status === 'pending' || proposal.status === 'approving'),
      limit,
    );
  }

  async listSettled(ownerUserId: string, limit = DEFAULT_LIST_LIMIT): Promise<EventMemoryCorrectionProposal[]> {
    return this.collect(
      (proposal) =>
        proposal.ownerUserId === ownerUserId && (proposal.status === 'approved' || proposal.status === 'rejected'),
      limit,
      true,
    );
  }

  async countActionableForEvents(
    ownerUserId: string,
    eventIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const counts = new Map(eventIds.map((eventId) => [eventId, 0]));
    for (const proposal of this.proposals.values()) {
      if (
        proposal.ownerUserId === ownerUserId &&
        (proposal.status === 'pending' || proposal.status === 'approving') &&
        counts.has(proposal.eventId)
      ) {
        counts.set(proposal.eventId, (counts.get(proposal.eventId) ?? 0) + 1);
      }
    }
    return counts;
  }

  async listActionableForEvent(
    ownerUserId: string,
    eventId: string,
    limit = DEFAULT_LIST_LIMIT,
  ): Promise<EventMemoryCorrectionProposal[]> {
    return this.collect(
      (proposal) =>
        proposal.ownerUserId === ownerUserId &&
        proposal.eventId === eventId &&
        (proposal.status === 'pending' || proposal.status === 'approving'),
      limit,
    );
  }

  async claimForApproval(proposalId: string, approvedBy: string): Promise<EventMemoryCorrectionProposal | null> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending' || proposal.ownerUserId !== approvedBy) return null;
    proposal.status = 'approving';
    proposal.approvedBy = approvedBy;
    return this.indexedSnapshot(proposal);
  }

  async finalizeApproval(
    proposalId: string,
    approvedBy: string,
    appliedRevision: string,
  ): Promise<EventMemoryCorrectionProposal | null> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approving' || proposal.ownerUserId !== approvedBy) return null;
    proposal.status = 'approved';
    proposal.approvedBy = approvedBy;
    proposal.approvedAt = Date.now();
    proposal.appliedRevision = appliedRevision;
    return this.indexedSnapshot(proposal);
  }

  async rollbackClaim(proposalId: string): Promise<boolean> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approving') return false;
    proposal.status = 'pending';
    delete proposal.approvedBy;
    return true;
  }

  async markRejected(
    proposalId: string,
    rejectedBy: string,
    rejectionReason: string,
  ): Promise<EventMemoryCorrectionProposal | null> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending' || proposal.ownerUserId !== rejectedBy) return null;
    proposal.status = 'rejected';
    proposal.rejectedBy = rejectedBy;
    proposal.rejectedAt = Date.now();
    proposal.rejectionReason = rejectionReason;
    return this.indexedSnapshot(proposal);
  }

  async getDedupProposalId(ownerUserId: string, clientRequestId: string): Promise<string | null> {
    return this.dedup.get(dedupKey(ownerUserId, clientRequestId)) ?? null;
  }

  async reserveDedup(ownerUserId: string, clientRequestId: string, proposalId: string): Promise<string> {
    const key = dedupKey(ownerUserId, clientRequestId);
    const existing = this.dedup.get(key);
    if (existing) return existing;
    this.dedup.set(key, proposalId);
    return proposalId;
  }

  async releaseDedup(ownerUserId: string, clientRequestId: string, expectedProposalId: string): Promise<void> {
    const key = dedupKey(ownerUserId, clientRequestId);
    if (this.dedup.get(key) === expectedProposalId && !this.proposals.has(expectedProposalId)) this.dedup.delete(key);
  }

  async getPublication(proposalId: string): Promise<ApprovalPublication | null> {
    return this.proposals.get(proposalId)?.publication ?? null;
  }

  async commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    assertApprovalEnvelopeIdentity(envelope, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F321',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.sourceCatId,
      createdAt: proposal.createdAt,
    });
    proposal.publication = commitApprovalEnvelope(proposal.publication, envelope);
  }

  async abortStaged(proposalId: string): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.publication?.state !== 'staged') return;
    this.historyIndex.update('', proposalId, null);
    this.proposals.delete(proposalId);
    await this.releaseDedup(proposal.ownerUserId, proposal.clientRequestId, proposalId);
  }

  private collect(
    predicate: (proposal: EventMemoryCorrectionProposal) => boolean,
    limit: number,
    settled = false,
  ): EventMemoryCorrectionProposal[] {
    const proposals = [...this.proposals.values()].filter(predicate);
    proposals.sort((left, right) => {
      const leftAt = settled ? (left.approvedAt ?? left.rejectedAt ?? left.createdAt) : left.createdAt;
      const rightAt = settled ? (right.approvedAt ?? right.rejectedAt ?? right.createdAt) : right.createdAt;
      return rightAt - leftAt || right.proposalId.localeCompare(left.proposalId);
    });
    return proposals.slice(0, Math.max(0, limit)).map(clone);
  }
}

function dedupKey(ownerUserId: string, clientRequestId: string): string {
  return `${ownerUserId}\0${clientRequestId}`;
}

function clone(proposal: EventMemoryCorrectionProposal): EventMemoryCorrectionProposal {
  return structuredClone(proposal);
}
