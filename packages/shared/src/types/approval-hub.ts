/**
 * F246 Approval Hub shared projection and provenance contracts.
 *
 * Approval lifecycle remains in each producer's canonical store. These types
 * describe the publication boundary and read-time Hub projection only.
 */

import { APPROVAL_PRODUCER_CATALOG } from '../approval-producer-catalog.js';

/** Producers admitted to the runtime registry in Wave 0. Later waves extend this union atomically with a binding. */
export type ApprovalProducerId = 'F128' | 'F139' | 'F193' | 'F221' | 'F225' | 'F231' | 'F260' | 'F276';

/** @deprecated Use ApprovalProducerId. Kept as a source-compatible alias during Phase I. */
export type ApprovalFeatureId = ApprovalProducerId;

export type ApprovalOriginRef =
  | { kind: 'message'; threadId: string; messageId: string }
  | { kind: 'event'; anchor: string; summary: string; threadId?: string };

export interface ApprovalCardRef {
  threadId: string;
  messageId: string;
}

export interface ApprovalEnvelope {
  canonicalProposalId: string;
  sourceFeatureId: ApprovalProducerId;
  ownerUserId: string;
  requesterCatId: string;
  originRef: ApprovalOriginRef;
  approvalCardRef: ApprovalCardRef;
  createdAt: number;
}

export type ApprovalEnvelopeIdentity = Pick<
  ApprovalEnvelope,
  'canonicalProposalId' | 'sourceFeatureId' | 'ownerUserId' | 'requesterCatId' | 'createdAt'
>;

export type ApprovalPublication =
  | { state: 'staged'; stagedAt: number }
  | { state: 'anchored'; envelope: ApprovalEnvelope }
  | { state: 'tombstoned'; failedAt: number; reason: string }
  | {
      state: 'legacy_unanchored';
      legacyThreadId?: string;
      legacyMessageId?: string;
      classifiedAt: number;
    };

export type ApprovalNavigation =
  | {
      state: 'anchored';
      originRef: ApprovalOriginRef;
      approvalCardRef: ApprovalCardRef;
    }
  | {
      state: 'legacy_unanchored';
      legacyThreadId?: string;
      legacyMessageId?: string;
    };

/** Hub display status — a projection, not a canonical store status. */
export type ApprovalItemStatus = 'pending' | 'stale';

/** Inline decision affordance. Defaults to approve-reject for backward compatibility. */
export type ApprovalDecisionMode = 'approve-reject' | 'resume-only' | 'claim-select';

/** Unified DTO that all producer adapters return. */
export interface ApprovalItem {
  proposalId: string;
  sourceFeatureId: ApprovalProducerId;
  requesterCatId: string;
  ownerUserId: string;
  status: ApprovalItemStatus;
  summary: string;
  detail: Record<string, unknown>;
  navigation: ApprovalNavigation;
  inlineApprovable: boolean;
  decisionMode?: ApprovalDecisionMode;
  expiresAt?: number;
  createdAt: number;
}

export type SettledStatus = 'approved' | 'rejected';

export interface SettledApprovalItem extends Omit<ApprovalItem, 'status' | 'expiresAt' | 'inlineApprovable'> {
  status: SettledStatus;
  decidedAt: number;
  decidedBy: string;
}

function requireNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must be non-empty`);
}

export function validateApprovalOriginRef(ref: ApprovalOriginRef): void {
  if (ref.kind === 'message') {
    requireNonBlank(ref.threadId, 'originRef.threadId');
    requireNonBlank(ref.messageId, 'originRef.messageId');
    return;
  }
  if ((ref as { kind: string }).kind !== 'event') {
    throw new Error('originRef.kind must be message or event');
  }
  requireNonBlank(ref.anchor, 'originRef.anchor');
  requireNonBlank(ref.summary, 'originRef.summary');
  if (ref.threadId !== undefined) requireNonBlank(ref.threadId, 'originRef.threadId');
}

export function validateApprovalCardRef(ref: ApprovalCardRef): void {
  requireNonBlank(ref.threadId, 'approvalCardRef.threadId');
  requireNonBlank(ref.messageId, 'approvalCardRef.messageId');
}

export function validateApprovalEnvelope(envelope: ApprovalEnvelope): void {
  requireNonBlank(envelope.canonicalProposalId, 'canonicalProposalId');
  if (!Object.hasOwn(APPROVAL_PRODUCER_CATALOG, envelope.sourceFeatureId)) {
    throw new Error('sourceFeatureId must be a registered approval producer');
  }
  requireNonBlank(envelope.ownerUserId, 'ownerUserId');
  requireNonBlank(envelope.requesterCatId, 'requesterCatId');
  if (!Number.isFinite(envelope.createdAt)) throw new Error('createdAt must be finite');
  validateApprovalOriginRef(envelope.originRef);
  validateApprovalCardRef(envelope.approvalCardRef);
}

export function assertApprovalEnvelopeIdentity(envelope: ApprovalEnvelope, expected: ApprovalEnvelopeIdentity): void {
  validateApprovalEnvelope(envelope);
  for (const field of [
    'canonicalProposalId',
    'sourceFeatureId',
    'ownerUserId',
    'requesterCatId',
    'createdAt',
  ] as const) {
    if (envelope[field] !== expected[field]) {
      throw new Error(`approval envelope ${field} does not match canonical proposal`);
    }
  }
}

export function validateApprovalPublication(publication: ApprovalPublication): void {
  switch (publication.state) {
    case 'staged':
      if (!Number.isFinite(publication.stagedAt)) throw new Error('publication.stagedAt must be finite');
      return;
    case 'anchored':
      validateApprovalEnvelope(publication.envelope);
      return;
    case 'tombstoned':
      if (!Number.isFinite(publication.failedAt)) throw new Error('publication.failedAt must be finite');
      requireNonBlank(publication.reason, 'publication.reason');
      return;
    case 'legacy_unanchored':
      if (!Number.isFinite(publication.classifiedAt)) throw new Error('publication.classifiedAt must be finite');
      if (publication.legacyThreadId !== undefined) {
        requireNonBlank(publication.legacyThreadId, 'publication.legacyThreadId');
      }
      if (publication.legacyMessageId !== undefined) {
        requireNonBlank(publication.legacyMessageId, 'publication.legacyMessageId');
      }
      return;
    default:
      throw new Error('publication.state must be staged, anchored, tombstoned, or legacy_unanchored');
  }
}

/** Pure immutable transition shared by in-memory feature stores. */
export function commitApprovalEnvelope(
  publication: ApprovalPublication | undefined,
  envelope: ApprovalEnvelope,
): ApprovalPublication {
  validateApprovalEnvelope(envelope);
  if (!publication) throw new Error('approval publication is not staged');
  if (publication.state === 'anchored') {
    if (JSON.stringify(publication.envelope) !== JSON.stringify(envelope)) {
      throw new Error('conflicting approval envelope');
    }
    return publication;
  }
  if (publication.state !== 'staged') {
    throw new Error(`approval publication is ${publication.state}, not staged`);
  }
  return { state: 'anchored', envelope };
}

export function validateApprovalNavigation(navigation: ApprovalNavigation): void {
  if (navigation.state === 'anchored') {
    validateApprovalOriginRef(navigation.originRef);
    validateApprovalCardRef(navigation.approvalCardRef);
    return;
  }
  if ((navigation as { state: string }).state !== 'legacy_unanchored') {
    throw new Error('navigation.state must be anchored or legacy_unanchored');
  }
  if (navigation.legacyThreadId !== undefined) {
    requireNonBlank(navigation.legacyThreadId, 'navigation.legacyThreadId');
  }
  if (navigation.legacyMessageId !== undefined) {
    requireNonBlank(navigation.legacyMessageId, 'navigation.legacyMessageId');
  }
}
