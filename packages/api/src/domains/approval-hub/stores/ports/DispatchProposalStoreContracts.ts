import type {
  ActionSuccessorRequestMetadata,
  ApprovalOriginRef,
  DispatchProposal,
  DispatchProposalStatus,
} from '@cat-cafe/shared';
import {
  ActionSuccessorIdentityError,
  canonicalizeActionIdentity,
  canonicalizeActionSubjectRef,
} from '../../../ball-custody/action-successor-identity.js';

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

/** Pending/rejected approval decisions that can deny a new canonical action. */
export type CanonicalAdmissionProposalStatus = Extract<DispatchProposalStatus, 'pending' | 'rejected'>;

/**
 * A cross-invocation admission lookup. `canonicalActionKey` is authoritative
 * for structured carriers. `canonicalSubjectRef` is only a deny candidate for
 * an actionless coordination carrier that cannot prove its full action key.
 */
export interface DispatchCanonicalAdmissionLookup {
  ownerUserId: string;
  canonicalActionKey?: string;
  canonicalSubjectRef?: string;
}

export interface DispatchCanonicalAdmissionBlock {
  proposalId: string;
  status: CanonicalAdmissionProposalStatus;
}

/** The F167 identity key used to compare a held proposal with a structured carrier. */
export function computeDispatchCanonicalActionKey(
  ownerUserId: string,
  action: Pick<ActionSuccessorRequestMetadata, 'subjectRef' | 'actionFamily' | 'successorSlot'>,
): string {
  return canonicalizeActionIdentity({
    tenantScope: ownerUserId,
    subjectRef: action.subjectRef,
    actionFamily: action.actionFamily,
    successorSlot: action.successorSlot,
  }).key;
}

function safelyCanonicalize<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ActionSuccessorIdentityError) return undefined;
    throw error;
  }
}

/** Invalid/legacy action metadata has no canonical identity to compare. */
export function tryComputeDispatchCanonicalActionKey(
  ownerUserId: string,
  action: Pick<ActionSuccessorRequestMetadata, 'subjectRef' | 'actionFamily' | 'successorSlot'>,
): string | undefined {
  return safelyCanonicalize(() => computeDispatchCanonicalActionKey(ownerUserId, action));
}

/** A weak carrier may name a subject, but it never receives a partial action key. */
export function canonicalizeDispatchAdmissionSubjectRef(subjectRef: string): string {
  return canonicalizeActionSubjectRef(subjectRef);
}

/** An opaque weak-carrier subject is communication-only, not an action identity. */
export function tryCanonicalizeDispatchAdmissionSubjectRef(subjectRef: string): string | undefined {
  return safelyCanonicalize(() => canonicalizeDispatchAdmissionSubjectRef(subjectRef));
}

export function isCanonicalAdmissionProposalStatus(
  status: DispatchProposalStatus,
): status is CanonicalAdmissionProposalStatus {
  return status === 'pending' || status === 'rejected';
}

export function isNegativeAuthorizationProposalStatus(
  status: DispatchProposalStatus,
): status is NegativeAuthorizationProposalStatus {
  return status === 'pending' || status === 'rejected' || status === 'superseded';
}
