import type { ApprovalPublication, DispatchProposal } from '@cat-cafe/shared';
import type { OwnerAuthProvenance } from '../../../cats/services/owner-auth-provenance.js';
import type { ApprovalPublicationStore } from '../../ports/ApprovalPublicationStore.js';
import type {
  CreateDispatchProposalInput,
  CreateDispatchProposalResult,
  DispatchCanonicalAdmissionBlock,
  DispatchCanonicalAdmissionLookup,
  DispatchLegacyNegativeAuthorizationLookup,
  DispatchNegativeAuthorizationBlock,
  DispatchNegativeAuthorizationLookup,
} from './DispatchProposalStoreContracts.js';

/** Canonical proposal lifecycle port; denial indexes are derived projections only. */
export interface IDispatchProposalStore extends ApprovalPublicationStore {
  create(input: CreateDispatchProposalInput): Promise<CreateDispatchProposalResult>;
  get(proposalId: string): Promise<DispatchProposal | null>;
  listPendingByUser(userId: string): Promise<DispatchProposal[]>;
  approve(
    proposalId: string,
    userId: string,
    ownerAuthProvenance: OwnerAuthProvenance,
  ): Promise<DispatchProposal | null>;
  getApprovalOwnerAuthProvenance(proposalId: string): Promise<OwnerAuthProvenance | undefined>;
  recordDelivery(proposalId: string, deliveredMessageId: string): Promise<void>;
  revertToPending(proposalId: string): Promise<DispatchProposal | null>;
  reject(proposalId: string, userId: string): Promise<DispatchProposal | null>;
  findByClientMessageId(clientMessageId: string, sourceThreadId: string): Promise<DispatchProposal | null>;
  findNegativeAuthorizationBlocks(
    input: DispatchNegativeAuthorizationLookup,
  ): Promise<DispatchNegativeAuthorizationBlock[]>;
  findCanonicalAdmissionBlocks(input: DispatchCanonicalAdmissionLookup): Promise<DispatchCanonicalAdmissionBlock[]>;
  findLegacyNegativeAuthorizationBlocks(
    input: DispatchLegacyNegativeAuthorizationLookup,
  ): Promise<DispatchNegativeAuthorizationBlock[]>;
  getNegativeAuthorizationLegacyCutoverAt(): Promise<number | undefined>;
  establishNegativeAuthorizationLegacyCutoverAt(cutoverAt: number): Promise<number>;
  rebuildNegativeAuthorizationIndexes(): Promise<{ exactIndexed: number; legacyIndexed: number }>;
  listSettledByUser(userId: string, limit: number): Promise<DispatchProposal[]>;
  getPublication(proposalId: string): Promise<ApprovalPublication | null>;
}
