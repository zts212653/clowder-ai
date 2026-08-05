import type {
  ActionSuccessorRequestMetadata,
  ApprovalOriginRef,
  DispatchProposal,
  DispatchProposalStatus,
} from '@cat-cafe/shared';

/** Fields provided at creation time (status/decided* set by store). */
export interface CreateDispatchProposalInput {
  proposalId: string;
  /** Required for all new producer writes; absent only on hydrated legacy records. */
  sourceInvocationId: string;
  sourceThreadId: string;
  targetThreadId: string;
  senderCatId: string;
  ownerUserId: string;
  content: string;
  targetCats: string[];
  replyTo?: string;
  clientMessageId?: string;
  proposedAction?: ActionSuccessorRequestMetadata;
  envelopeDigest?: string;
  approvalOriginRef?: ApprovalOriginRef;
  cardMessageId?: string;
  createdAt: number;
}

export interface CreateDispatchProposalResult {
  proposal: DispatchProposal;
  /** Proposals atomically moved pending→superseded by this create. */
  supersededProposals: DispatchProposal[];
}

/** Lineage K = (sourceThreadId, targetThreadId, senderCatId). */
export function computeLineageKey(sourceThreadId: string, targetThreadId: string, senderCatId: string): string {
  return `${sourceThreadId}:${targetThreadId}:${senderCatId}`;
}

/**
 * Compact candidate projection only. Source thread/sender are revalidated
 * against the canonical proposal on lookup; this key never grants custody.
 */
export function computeNegativeAuthorizationKey(
  ownerUserId: string,
  sourceInvocationId: string,
  targetThreadId: string,
  canonicalTargetCatId: string,
): string {
  return [ownerUserId, sourceInvocationId, targetThreadId, canonicalTargetCatId]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

/** Legacy candidates are checked only for invocations predating a durable cutover. */
export function computeLegacyNegativeAuthorizationKey(
  ownerUserId: string,
  sourceThreadId: string,
  senderCatId: string,
  targetThreadId: string,
  canonicalTargetCatId: string,
): string {
  return [ownerUserId, sourceThreadId, senderCatId, targetThreadId, canonicalTargetCatId]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

export type NegativeAuthorizationProposalStatus = Exclude<DispatchProposalStatus, 'approved'>;

export interface DispatchNegativeAuthorizationLookup {
  ownerUserId: string;
  sourceInvocationId: string;
  sourceThreadId: string;
  senderCatId: string;
  targetThreadId: string;
  /** Already canonical, post-routing target IDs for the carrier. */
  targetCats: readonly string[];
}

export interface DispatchLegacyNegativeAuthorizationLookup {
  ownerUserId: string;
  sourceThreadId: string;
  senderCatId: string;
  targetThreadId: string;
  targetCats: readonly string[];
  /** Callback invocation creation time, not server process start time. */
  invocationCreatedAt: number;
  /** Durable activation point after the legacy index has been rebuilt. */
  cutoverAt: number;
}

export interface DispatchNegativeAuthorizationBlock {
  proposalId: string;
  status: NegativeAuthorizationProposalStatus;
  /** Canonical carrier targets intersecting this proposal's held target set. */
  targetCats: string[];
}

export function isNegativeAuthorizationProposalStatus(
  status: DispatchProposalStatus,
): status is NegativeAuthorizationProposalStatus {
  return status === 'pending' || status === 'rejected' || status === 'superseded';
}
