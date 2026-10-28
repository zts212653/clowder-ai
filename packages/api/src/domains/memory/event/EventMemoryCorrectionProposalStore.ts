import type {
  ApprovalOriginRef,
  EventMemoryCorrectionPatch,
  EventMemoryCorrectionProposal,
  MemoryCorrectionReason,
} from '@cat-cafe/shared';
import type { SettledHistoryPageOptions, SettledHistorySourcePage } from '../../../utils/settled-history-page.js';
import type { ApprovalPublicationStore } from '../../approval-hub/ports/ApprovalPublicationStore.js';

export interface CreateEventMemoryCorrectionProposalInput {
  proposalId: string;
  eventId: string;
  expectedRevision: string;
  reason: MemoryCorrectionReason;
  suggestedPatch: EventMemoryCorrectionPatch;
  ownerUserId: string;
  sourceCatId: string;
  sourceThreadId: string;
  sourceInvocationId: string;
  source: { threadId: string; messageId: string };
  clientRequestId: string;
  approvalOriginRef: ApprovalOriginRef;
}

export interface EventMemoryCorrectionProposalStore extends ApprovalPublicationStore {
  create(input: CreateEventMemoryCorrectionProposalInput): Promise<EventMemoryCorrectionProposal>;
  get(proposalId: string): Promise<EventMemoryCorrectionProposal | null>;
  listActionable(ownerUserId: string, limit?: number): Promise<EventMemoryCorrectionProposal[]>;
  listSettledPage?(
    owner: string,
    options: SettledHistoryPageOptions,
  ):
    | SettledHistorySourcePage<EventMemoryCorrectionProposal>
    | Promise<SettledHistorySourcePage<EventMemoryCorrectionProposal>>;
  listSettled(ownerUserId: string, limit?: number): Promise<EventMemoryCorrectionProposal[]>;
  countActionableForEvents(ownerUserId: string, eventIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  listActionableForEvent(
    ownerUserId: string,
    eventId: string,
    limit?: number,
  ): Promise<EventMemoryCorrectionProposal[]>;
  claimForApproval(proposalId: string, approvedBy: string): Promise<EventMemoryCorrectionProposal | null>;
  finalizeApproval(
    proposalId: string,
    approvedBy: string,
    appliedRevision: string,
  ): Promise<EventMemoryCorrectionProposal | null>;
  rollbackClaim(proposalId: string): Promise<boolean>;
  markRejected(
    proposalId: string,
    rejectedBy: string,
    rejectionReason: string,
  ): Promise<EventMemoryCorrectionProposal | null>;
  getDedupProposalId(ownerUserId: string, clientRequestId: string): Promise<string | null>;
  reserveDedup(ownerUserId: string, clientRequestId: string, proposalId: string): Promise<string>;
  releaseDedup(ownerUserId: string, clientRequestId: string, expectedProposalId: string): Promise<void>;
}
