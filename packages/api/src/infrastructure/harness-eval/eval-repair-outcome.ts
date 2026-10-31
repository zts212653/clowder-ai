import {
  exactAssetVersionRefV1Schema,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import {
  classifyDrift,
  deriveFreshCaseActionRef,
  locateEvalRepairApproval,
  snapshot,
} from './eval-repair-approval-contracts.js';
import type { EvalRepairApprovalRecord } from './eval-repair-approval-projection.js';
import { recordFreshEvalRepairOutcome } from './eval-repair-fresh-outcome.js';
import {
  commitIntervention,
  type EvalRepairInterventionEvent,
  findAnyIntervention,
  findIntervention,
  interventionKind,
} from './eval-repair-intervention-commit.js';
import type {
  EvalRepairBoundRefs,
  EvalRepairInterventionReceipt,
  EvalRepairOutcomeBlockReason,
  EvalRepairOutcomeCommandResult,
  EvalRepairOutcomeInput,
  EvalRepairOutcomeServiceOptions,
} from './eval-repair-outcome-contracts.js';
import { projectEvalRepairOutcome } from './eval-repair-outcome-projection.js';
import { evalRepairCaseRef, evalRepairProposalRef } from './eval-repair-outcome-refs.js';
import { supersedeEvalRepairApproval } from './eval-repair-supersession.js';

export { evalRepairCaseRef, evalRepairProposalRef } from './eval-repair-outcome-refs.js';

type Located = Awaited<ReturnType<typeof locateEvalRepairApproval>>;
type Bound = {
  located: NonNullable<Located>;
  record: EvalRepairApprovalRecord;
  refs: EvalRepairBoundRefs;
  receiptRef: OwnerTruthRefV1;
};
type Blocked = Extract<EvalRepairOutcomeCommandResult, { status: 'blocked' }>;

function blocked(reason: EvalRepairOutcomeBlockReason): Blocked {
  return { status: 'blocked', reason };
}

function same(left: unknown, right: unknown): boolean {
  try {
    return refIdentity(left as never) === refIdentity(right as never);
  } catch {
    return false;
  }
}

function proposalIdFrom(ref: OwnerTruthRefV1): string | undefined {
  const prefix = 'eval-repair-proposal:';
  if (ref.ownerFeatureId !== 'F266' || !ref.ownerStateRef.startsWith(prefix)) return undefined;
  return ref.ownerStateRef.slice(prefix.length) || undefined;
}

function parseRefs(raw: EvalRepairBoundRefs & { receiptRef: OwnerTruthRefV1 }) {
  try {
    return {
      caseRef: ownerTruthRefV1Schema.parse(raw.caseRef),
      proposalRef: ownerTruthRefV1Schema.parse(raw.proposalRef),
      approvalRef: ownerTruthRefV1Schema.parse(raw.approvalRef),
      ownerAuthorizationRef: ownerTruthRefV1Schema.parse(raw.ownerAuthorizationRef),
      targetVersionRef: exactAssetVersionRefV1Schema.parse(raw.targetVersionRef),
      interventionRef: ownerTruthRefV1Schema.parse(raw.interventionRef),
      receiptRef: ownerTruthRefV1Schema.parse(raw.receiptRef),
    };
  } catch {
    return undefined;
  }
}

function canonicalBindingBlock(record: EvalRepairApprovalRecord, refs: EvalRepairBoundRefs): Blocked | undefined {
  if (!record.proposal.ownerLineage) return blocked('binding_missing');
  if (!same(refs.caseRef, evalRepairCaseRef(record.proposal.caseId, record.proposal.verdictId))) {
    return blocked('case_mismatch');
  }
  if (!same(refs.proposalRef, evalRepairProposalRef(record.proposal.proposalId))) {
    return blocked('proposal_mismatch');
  }
  if (!record.approvalRef || !same(refs.approvalRef, record.approvalRef)) return blocked('approval_mismatch');
  if (!same(refs.ownerAuthorizationRef, record.proposal.requestSnapshot.ownerAuthorizationRef)) {
    return blocked('authorization_mismatch');
  }
  if (!same(refs.targetVersionRef, record.proposal.requestSnapshot.targetVersionRef)) {
    return blocked('target_mismatch');
  }
  if (!same(refs.interventionRef, record.proposal.ownerLineage.interventionRef)) {
    return blocked('intervention_mismatch');
  }
  if (record.supersededByCaseActionRef) {
    return {
      status: 'blocked',
      reason: 'approval_superseded',
      ...(record.supersessionDrift ? { drift: record.supersessionDrift } : {}),
      freshCaseActionRef: record.supersededByCaseActionRef,
    };
  }
  if (record.lifecycle.resolution !== 'accepted') return blocked('approval_not_accepted');
  return undefined;
}

function receiptBindingMatches(receipt: EvalRepairInterventionReceipt, bound: Bound): boolean {
  return (
    same(receipt.receiptRef, bound.receiptRef) &&
    same(receipt.caseRef, bound.refs.caseRef) &&
    same(receipt.proposalRef, bound.refs.proposalRef) &&
    same(receipt.approvalRef, bound.refs.approvalRef) &&
    same(receipt.ownerAuthorizationRef, bound.refs.ownerAuthorizationRef) &&
    same(receipt.targetVersionRef, bound.refs.targetVersionRef) &&
    same(receipt.interventionRef, bound.refs.interventionRef)
  );
}

function validTime(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function releaseErrorReason(
  error: unknown,
  fallback: 'main_not_landed' | 'live_not_active',
): 'main_not_landed' | 'live_not_active' {
  if (typeof error !== 'object' || error === null || !('code' in error)) return fallback;
  return error.code === 'main_not_landed' || error.code === 'live_not_active' ? error.code : fallback;
}

function requireOwnerLineage(record: EvalRepairApprovalRecord) {
  if (!record.proposal.ownerLineage) throw new Error('validated owner lineage disappeared');
  return record.proposal.ownerLineage;
}

export class EvalRepairOutcomeService {
  private readonly now: () => string;

  constructor(private readonly options: EvalRepairOutcomeServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async recordIntervention(
    input: EvalRepairBoundRefs & { receiptRef: OwnerTruthRefV1 },
  ): Promise<EvalRepairOutcomeCommandResult> {
    const bound = await this.bind(input);
    if ('status' in bound) return bound;
    const events = await this.options.eventLog.read(bound.located.caseId);
    const existing = findIntervention(events, bound.record.proposal.proposalId, bound.receiptRef);
    if (existing) return { status: 'duplicate', kind: interventionKind(existing) };
    if (findAnyIntervention(events, bound.record.proposal.proposalId)) return blocked('idempotency_collision');
    const revalidated = await this.revalidateOwner(bound);
    if (revalidated) return revalidated;
    if (!bound.record.materialization) return blocked('approval_not_materialized');
    const receipt = await this.options.interventionReceiptOwner.resolve(bound.receiptRef);
    if (!receipt) return blocked('owner_receipt_not_found');
    if (!receiptBindingMatches(receipt, bound)) return blocked('owner_receipt_mismatch');
    const event = this.interventionEvent(bound, receipt);
    if ('status' in event) return event;
    return commitIntervention(
      this.options.eventLog,
      bound.located.caseId,
      bound.record.proposal.proposalId,
      bound.receiptRef,
      event,
    );
  }

  async recordOutcome(input: EvalRepairOutcomeInput): Promise<EvalRepairOutcomeCommandResult> {
    return recordFreshEvalRepairOutcome({ options: this.options, raw: input, now: this.now });
  }

  async resolveChange(caseRef: OwnerTruthRefV1, proposalRef: OwnerTruthRefV1) {
    const proposalId = proposalIdFrom(proposalRef);
    if (!proposalId) return null;
    const located = await locateEvalRepairApproval(this.options.eventLog, proposalId);
    if (!located || !same(caseRef, evalRepairCaseRef(located.caseId, located.record.proposal.verdictId))) return null;
    return projectEvalRepairOutcome(await this.options.eventLog.read(located.caseId), proposalId);
  }

  private async bind(raw: EvalRepairBoundRefs & { receiptRef: OwnerTruthRefV1 }): Promise<Bound | Blocked> {
    const parsed = parseRefs(raw);
    if (!parsed) return blocked('binding_missing');
    const proposalId = proposalIdFrom(parsed.proposalRef);
    if (!proposalId) return blocked('proposal_mismatch');
    const located = await locateEvalRepairApproval(this.options.eventLog, proposalId);
    if (!located) return blocked('proposal_not_found');
    const refBlocker = canonicalBindingBlock(located.record, parsed);
    if (refBlocker) return refBlocker;
    return { located, record: located.record, refs: parsed, receiptRef: parsed.receiptRef };
  }

  private async revalidateOwner(bound: Bound): Promise<Blocked | undefined> {
    const action = await this.options.resolveCaseAction(bound.record.proposal.caseActionRef);
    if (!action) return blocked('case_action_not_found');
    const current = await this.options.resolveOwnerChangeContract({
      caseId: action.caseId,
      verdictId: action.verdictId,
      featureId: action.repairTarget.featureId,
      ...(action.repairTarget.componentId ? { componentId: action.repairTarget.componentId } : {}),
      expectedTargetVersion: action.repairTarget.version,
    });
    if (current.status === 'blocked') return blocked(current.reason);
    const currentSnapshot = snapshot(current);
    const drift = classifyDrift(bound.record.proposal.requestSnapshot, currentSnapshot);
    if (!drift) return undefined;
    const freshCaseActionRef = deriveFreshCaseActionRef(bound.record, currentSnapshot);
    const superseded = await supersedeEvalRepairApproval({
      eventLog: this.options.eventLog,
      caseId: bound.located.caseId,
      proposalId: bound.record.proposal.proposalId,
      owner: currentSnapshot,
      drift,
      occurredAt: this.now(),
      allowMaterialized: true,
    });
    return {
      status: 'blocked',
      reason: 'approval_superseded',
      drift,
      freshCaseActionRef: superseded.status === 'superseded' ? superseded.freshCaseActionRef : freshCaseActionRef,
    };
  }

  private interventionEvent(
    bound: Bound,
    receipt: EvalRepairInterventionReceipt,
  ): EvalRepairInterventionEvent | Blocked {
    const decisionAt = validTime(bound.record.decidedAt ?? '');
    if (receipt.kind === 'changed') {
      return this.changedInterventionEvent(bound, receipt, decisionAt);
    }
    return this.noChangeInterventionEvent(bound, receipt, decisionAt);
  }

  private changedInterventionEvent(
    bound: Bound,
    receipt: Extract<EvalRepairInterventionReceipt, { kind: 'changed' }>,
    decisionAt: number | undefined,
  ): EvalRepairInterventionEvent | Blocked {
    const changedAt = validTime(receipt.changedAt);
    const loadedAt = validTime(receipt.loadedAt);
    if (!decisionAt || !changedAt || !loadedAt || changedAt < decisionAt || loadedAt < changedAt) {
      return blocked('invalid_receipt_time');
    }
    try {
      const main = this.options.releaseTruth.verifyMainLanded(receipt.mainCommitSha);
      if (main.commitSha !== receipt.mainCommitSha) return blocked('main_not_landed');
    } catch (error) {
      return blocked(releaseErrorReason(error, 'main_not_landed'));
    }
    try {
      const live = this.options.releaseTruth.verifyLiveActive(receipt.mainCommitSha);
      if (live.commitSha !== receipt.mainCommitSha) return blocked('live_not_active');
    } catch (error) {
      return blocked(releaseErrorReason(error, 'live_not_active'));
    }
    if (
      !this.options.releaseTruth.loadedRuntimeHead ||
      receipt.loadedRuntimeRef.version !== this.options.releaseTruth.loadedRuntimeHead
    ) {
      return blocked('loaded_runtime_mismatch');
    }
    return this.changedEvent(bound, receipt);
  }

  private noChangeInterventionEvent(
    bound: Bound,
    receipt: Extract<EvalRepairInterventionReceipt, { kind: 'no_change' }>,
    decisionAt: number | undefined,
  ): EvalRepairInterventionEvent | Blocked {
    const recordedAt = validTime(receipt.recordedAt);
    const nextEvalAt = validTime(receipt.nextEvalAt);
    if (!decisionAt || !recordedAt || !nextEvalAt || recordedAt < decisionAt || nextEvalAt <= recordedAt) {
      return blocked('invalid_receipt_time');
    }
    return this.noChangeEvent(bound, receipt);
  }

  private eventBase(bound: Bound, receiptRef: OwnerTruthRefV1) {
    return {
      eventId: `f266:${bound.located.caseId}:intervention:${bound.record.proposal.proposalId}`,
      caseId: bound.located.caseId,
      verdictId: bound.record.proposal.verdictId,
      domainId: bound.record.proposal.domainId,
      actor: { kind: 'automation' as const, id: 'eval-repair-outcome-recorder' },
      occurredAt: this.now(),
      reason: 'canonical asset owner receipt validated against exact Approval and target bindings',
      refs: [
        { kind: 'other' as const, availability: 'available' as const, value: receiptRef.ownerStateRef },
        { kind: 'other' as const, availability: 'available' as const, value: bound.refs.interventionRef.ownerStateRef },
      ],
      proposalId: bound.record.proposal.proposalId,
      caseActionRef: bound.record.proposal.caseActionRef,
      approvalRef: bound.refs.approvalRef,
      requestSnapshot: bound.record.proposal.requestSnapshot,
      ownerLineage: requireOwnerLineage(bound.record),
      interventionReceiptRef: receiptRef,
    };
  }

  private changedEvent(bound: Bound, receipt: Extract<EvalRepairInterventionReceipt, { kind: 'changed' }>) {
    return {
      ...this.eventBase(bound, receipt.receiptRef),
      type: 'repair_intervention_changed' as const,
      assetVersionRef: exactAssetVersionRefV1Schema.parse(receipt.assetVersionRef),
      mainCommitSha: receipt.mainCommitSha,
      loadedRuntimeRef: ownerTruthRefV1Schema.parse(receipt.loadedRuntimeRef),
      changedAt: receipt.changedAt,
      loadedAt: receipt.loadedAt,
    };
  }

  private noChangeEvent(bound: Bound, receipt: Extract<EvalRepairInterventionReceipt, { kind: 'no_change' }>) {
    return {
      ...this.eventBase(bound, receipt.receiptRef),
      type: 'repair_intervention_no_change' as const,
      reasonCode: receipt.reasonCode,
      withdrawalCondition: receipt.withdrawalCondition,
      nextEvalAt: receipt.nextEvalAt,
      recordedAt: receipt.recordedAt,
    };
  }
}
