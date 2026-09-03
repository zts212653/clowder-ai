import { createHash } from 'node:crypto';
import {
  type ApprovalEnvelope,
  type ExactAssetVersionRefV1,
  exactAssetVersionRefV1Schema,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  type RichCardBlock,
  refIdentity,
} from '@cat-cafe/shared';
import type { ApprovalIngress } from '../../domains/approval-hub/ApprovalIngress.js';
import type { ApprovalEpochAuthorization } from '../../domains/approval-hub/ApprovalLifecycleEpochAuthority.js';
import type { EvalRepairApprovalRecord, EvalRepairApprovalSnapshot } from './eval-repair-approval-projection.js';
import { projectEvalRepairApprovals } from './eval-repair-approval-projection.js';
import type { IReevalClosureEventLog } from './reeval-closure-event-log.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

export type EvalRepairOwnerBlockReason =
  | 'owner_unresolved'
  | 'owner_ambiguous'
  | 'owner_authorization_missing'
  | 'owner_authorization_unreadable'
  | 'owner_authorization_expired'
  | 'owner_authorization_target_mismatch'
  | 'target_version_mismatch';

export type EvalRepairOwnerResolution =
  | ({ status: 'resolved' } & EvalRepairApprovalSnapshot)
  | { status: 'blocked'; reason: EvalRepairOwnerBlockReason; blockerRef: OwnerTruthRefV1 };

export interface EvalRepairCaseAction {
  caseId: string;
  verdictId: string;
  domainId: string;
  findingKey: string;
  analysisDisposition: 'repair' | 'no_repair' | 'observe' | 'insufficient';
  approvalRequirement:
    | { kind: 'required'; reason: 'repair' | 'accept_no_change' | 'extend_budget' | 'change_scope' | 'change_owner' }
    | { kind: 'not_required' };
  findingArtifactRef: string;
  repairTarget: { featureId: string; componentId?: string; version: string };
  expectedChange: string;
  costAndRollback: string;
  withdrawalCondition: string;
  supersedesProposalId?: string;
}

export interface EvalRepairAuthenticatedPrincipal {
  invocationId: string;
  userId: string;
  catId: string;
  threadId: string;
  originMessageId: string;
}

export interface CanonicalRepairDispatchInput extends EvalRepairApprovalSnapshot {
  dispatchId: string;
  caseRef: OwnerTruthRefV1;
  proposalRef: OwnerTruthRefV1;
  approvalRef: OwnerTruthRefV1;
}

export interface CanonicalRepairDispatchReceipt {
  taskRef: OwnerTruthRefV1;
  leaseRef: OwnerTruthRefV1;
  custodyReceiptRef: OwnerTruthRefV1;
}

/**
 * The canonical repair owner is the atomic authorization boundary. It must
 * compare the supplied opaque refs with its current owner/target truth in the
 * same transaction that upserts custody. A stale result proves zero Task/lease
 * side effects for this stable dispatchId.
 */
export type CanonicalRepairDispatchOutcome =
  | { status: 'materialized'; receipt: CanonicalRepairDispatchReceipt }
  | {
      status: 'stale';
      currentSnapshot: EvalRepairApprovalSnapshot;
      rejectionRef: OwnerTruthRefV1;
    }
  | {
      status: 'blocked';
      reason: EvalRepairOwnerBlockReason;
      blockerRef: OwnerTruthRefV1;
    };

export interface EvalRepairApprovalServiceOptions {
  eventLog: IReevalClosureEventLog;
  epochAuthority: {
    authorize(
      producerId: 'F266',
      writer: 'v1',
      operation: 'proposal_ingress' | 'decision' | 'materialization',
    ): Promise<ApprovalEpochAuthorization>;
  };
  resolveCaseAction: (caseActionRef: string) => Promise<EvalRepairCaseAction | null>;
  resolveOwnerChangeContract: (input: {
    caseId: string;
    verdictId: string;
    featureId: string;
    componentId?: string;
    expectedTargetVersion: string;
  }) => Promise<EvalRepairOwnerResolution>;
  approvalIngress: Pick<ApprovalIngress, 'publish'>;
  canonicalRepairDispatcher: {
    /**
     * Canonical owner boundary. Implementations MUST atomically validate the
     * exact opaque refs and upsert one Task/F167 custody by dispatchId. Every
     * replay must return the same terminal materialized/stale outcome.
     */
    materialize(input: CanonicalRepairDispatchInput): Promise<CanonicalRepairDispatchOutcome>;
  };
  now?: () => string;
}

export type EvalRepairDecisionReason =
  | 'accepted_as_proposed'
  | 'wrong_target'
  | 'insufficient_evidence'
  | 'not_now'
  | 'cost_too_high'
  | 'other';

export type EvalRepairProposeResult =
  | { status: 'published'; proposalId: string; approvalPublicationRef: string }
  | { status: 'not_required'; disposition: 'no_repair' | 'observe' | 'insufficient' }
  | { status: 'superseded'; freshCaseActionRef: string; drift?: 'owner' | 'authorization' | 'target' }
  | {
      status: 'blocked';
      reason:
        | EvalRepairOwnerBlockReason
        | 'case_action_not_found'
        | 'approval_lifecycle_unavailable'
        | 'approval_materialization_in_progress'
        | 'approval_already_materialized';
    };

export type EvalRepairDecisionResult =
  | { status: 'accepted' | 'rejected' | 'closed_without_decision' }
  | { status: 'duplicate'; resolution: 'accepted' | 'rejected' | 'closed_without_decision' }
  | {
      status: 'blocked';
      reason: 'approval_lifecycle_unavailable' | 'proposal_not_found' | 'approval_not_anchored';
    };

export type EvalRepairMaterializeResult =
  | { status: 'materialized' | 'duplicate'; receipt: CanonicalRepairDispatchReceipt }
  | { status: 'not_eligible'; resolution: 'open' | 'rejected' | 'closed_without_decision' }
  | { status: 'superseded'; freshCaseActionRef: string; drift: 'owner' | 'authorization' | 'target' }
  | {
      status: 'blocked';
      reason:
        | EvalRepairOwnerBlockReason
        | 'approval_lifecycle_unavailable'
        | 'proposal_not_found'
        | 'case_action_not_found'
        | 'approval_materialization_in_progress';
    };

export function buildEvalRepairApprovalCard(input: {
  proposalId: string;
  summary: string;
  expectedChange: string;
  costAndRollback: string;
  withdrawalCondition: string;
  targetVersionRef: ExactAssetVersionRefV1;
}): RichCardBlock {
  return {
    id: `eval-repair-proposal-${input.proposalId}`,
    kind: 'card',
    v: 1,
    title: input.summary,
    bodyMarkdown: input.expectedChange,
    tone: 'warning',
    fields: [
      { label: '成本与回滚', value: input.costAndRollback },
      { label: '撤回条件', value: input.withdrawalCondition },
      { label: '精确目标', value: input.targetVersionRef.version },
    ],
    actions: [
      { label: '批准', action: 'eval-repair:approve', payload: { proposalId: input.proposalId } },
      { label: '拒绝', action: 'eval-repair:reject', payload: { proposalId: input.proposalId } },
    ],
  };
}

export function snapshot(input: EvalRepairApprovalSnapshot): EvalRepairApprovalSnapshot {
  return {
    ownerRef: ownerTruthRefV1Schema.parse(input.ownerRef),
    ownerAuthorizationRef: ownerTruthRefV1Schema.parse(input.ownerAuthorizationRef),
    targetVersionRef: exactAssetVersionRefV1Schema.parse(input.targetVersionRef),
    dispatchRef: ownerTruthRefV1Schema.parse(input.dispatchRef),
  };
}

export function classifyDrift(
  prior: EvalRepairApprovalSnapshot,
  current: EvalRepairApprovalSnapshot,
): 'owner' | 'authorization' | 'target' | undefined {
  if (refIdentity(prior.ownerRef) !== refIdentity(current.ownerRef)) return 'owner';
  if (refIdentity(prior.ownerAuthorizationRef) !== refIdentity(current.ownerAuthorizationRef)) return 'authorization';
  if (refIdentity(prior.targetVersionRef) !== refIdentity(current.targetVersionRef)) return 'target';
  if (refIdentity(prior.dispatchRef) !== refIdentity(current.dispatchRef)) return 'owner';
  return undefined;
}

export function deriveProposalId(action: EvalRepairCaseAction, owner: EvalRepairApprovalSnapshot): string {
  return `eval-repair-v1-${digest([
    action.caseId,
    action.verdictId,
    refIdentity(owner.ownerRef),
    refIdentity(owner.ownerAuthorizationRef),
    refIdentity(owner.targetVersionRef),
  ])}`;
}

export function deriveRequestIdempotencyRef(
  principal: EvalRepairAuthenticatedPrincipal,
  clientMessageId: string,
  caseActionRef: string,
): string {
  return `idempotency:F266:${digest([
    principal.invocationId,
    principal.threadId,
    principal.originMessageId,
    clientMessageId,
    caseActionRef,
  ])}`;
}

export function deriveFreshCaseActionRef(record: EvalRepairApprovalRecord, owner: EvalRepairApprovalSnapshot): string {
  return `case-action:f266:${digest([
    record.proposal.caseId,
    record.proposal.proposalId,
    refIdentity(owner.ownerRef),
    refIdentity(owner.ownerAuthorizationRef),
    refIdentity(owner.targetVersionRef),
  ])}`;
}

export function deriveDispatchId(proposalId: string, owner: EvalRepairApprovalSnapshot): string {
  return `f266-repair-v1-${digest([
    proposalId,
    refIdentity(owner.targetVersionRef),
    refIdentity(owner.ownerAuthorizationRef),
  ])}`;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

export function receiptFrom(record: EvalRepairApprovalRecord): CanonicalRepairDispatchReceipt {
  if (!record.materialization) throw new Error('materialization receipt missing');
  return {
    taskRef: record.materialization.taskRef,
    leaseRef: record.materialization.leaseRef,
    custodyReceiptRef: record.materialization.custodyReceiptRef,
  };
}

export function validateDispatchReceipt(receipt: CanonicalRepairDispatchReceipt): void {
  ownerTruthRefV1Schema.parse(receipt.taskRef);
  ownerTruthRefV1Schema.parse(receipt.leaseRef);
  ownerTruthRefV1Schema.parse(receipt.custodyReceiptRef);
}

export function assertDispatchReceiptMatches(
  candidate: CanonicalRepairDispatchReceipt,
  canonical: CanonicalRepairDispatchReceipt,
): void {
  for (const key of ['taskRef', 'leaseRef', 'custodyReceiptRef'] as const) {
    if (refIdentity(candidate[key]) !== refIdentity(canonical[key])) {
      throw new Error(`canonical repair dispatcher returned conflicting ${key} for one dispatchId`);
    }
  }
}

export function validatePrincipal(principal: EvalRepairAuthenticatedPrincipal): void {
  requireNonEmpty(principal.invocationId, 'principal.invocationId');
  requireNonEmpty(principal.userId, 'principal.userId');
  requireNonEmpty(principal.catId, 'principal.catId');
  requireNonEmpty(principal.threadId, 'principal.threadId');
  requireNonEmpty(principal.originMessageId, 'principal.originMessageId');
}

export function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
}

export async function locateEvalRepairApproval(
  eventLog: IReevalClosureEventLog,
  proposalId: string,
): Promise<{ caseId: string; record: EvalRepairApprovalRecord; expectedSequence: number } | null> {
  for (const subjectId of await eventLog.listSubjectIds()) {
    const events = await eventLog.read(subjectId);
    const record = projectEvalRepairApprovals(events).proposals.find(
      (candidate) => candidate.proposal.proposalId === proposalId,
    );
    if (record) return { caseId: subjectId, record, expectedSequence: events.length };
  }
  return null;
}

export async function appendEvalRepairEvent(
  eventLog: IReevalClosureEventLog,
  caseId: string,
  event: EvalLifecycleEvent,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await eventLog.read(caseId);
    const result = await eventLog.append(event, current.length);
    if (result.outcome !== 'conflict') return;
  }
  throw new Error(`F266 Approval event CAS did not converge for ${caseId}`);
}

export function approvalEnvelopeRef(envelope: ApprovalEnvelope): OwnerTruthRefV1 {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F246',
    ownerStateRef: `approval-envelope:F266:${envelope.canonicalProposalId}`,
  });
}
