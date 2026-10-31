import { ownerTruthRefV1Schema } from '@cat-cafe/shared';
import {
  assertDispatchReceiptMatches,
  type CanonicalRepairDispatchInput,
  type CanonicalRepairDispatchOutcome,
  type CanonicalRepairDispatchReceipt,
  classifyDrift,
  deriveDispatchId,
  type EvalRepairApprovalServiceOptions,
  type EvalRepairCaseAction,
  type EvalRepairMaterializeResult,
  type EvalRepairOwnerResolution,
  locateEvalRepairApproval,
  receiptFrom,
  snapshot,
  validateDispatchReceipt,
} from './eval-repair-approval-contracts.js';
import type { EvalRepairApprovalRecord } from './eval-repair-approval-projection.js';
import { supersedeEvalRepairApproval } from './eval-repair-supersession.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

interface MaterializationInput {
  options: EvalRepairApprovalServiceOptions;
  now: () => string;
  proposalId: string;
  resolveOwner: (action: EvalRepairCaseAction) => Promise<EvalRepairOwnerResolution>;
}

const RETRY = Symbol('retry');
type MaterializationAdvance = EvalRepairMaterializeResult | typeof RETRY;

export async function materializeEvalRepairApproval(input: MaterializationInput): Promise<EvalRepairMaterializeResult> {
  const permit = await input.options.epochAuthority.authorize('F266', 'v1', 'materialization');
  if (!permit.allowed) return { status: 'blocked', reason: 'approval_lifecycle_unavailable' };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const advanced = await advanceMaterialization(input);
    if (advanced !== RETRY) return advanced;
  }
  throw new Error(`F266 materialization reservation CAS did not converge for ${input.proposalId}`);
}

async function advanceMaterialization(input: MaterializationInput): Promise<MaterializationAdvance> {
  const located = await locateEvalRepairApproval(input.options.eventLog, input.proposalId);
  if (!located) return { status: 'blocked', reason: 'proposal_not_found' };
  const settled = settledMaterialization(located.record);
  if (settled) return settled;
  if (located.record.materializationAttempt) return dispatchReserved(input, located.caseId, located.record);
  return prepareDispatch(input, located.caseId, located.record, located.expectedSequence);
}

function settledMaterialization(record: EvalRepairApprovalRecord): EvalRepairMaterializeResult | undefined {
  if (record.materialization) return { status: 'duplicate', receipt: receiptFrom(record) };
  if (record.supersededByCaseActionRef) return recoveredSupersession(record);
  if (record.lifecycle.resolution !== 'accepted') {
    return { status: 'not_eligible', resolution: record.lifecycle.resolution };
  }
  return undefined;
}

async function prepareDispatch(
  input: MaterializationInput,
  caseId: string,
  record: EvalRepairApprovalRecord,
  expectedSequence: number,
): Promise<MaterializationAdvance> {
  const action = await input.options.resolveCaseAction(record.proposal.caseActionRef);
  if (!action) return { status: 'blocked', reason: 'case_action_not_found' };
  const owner = await input.resolveOwner(action);
  if (owner.status === 'blocked') return { status: 'blocked', reason: owner.reason };
  const drift = classifyDrift(record.proposal.requestSnapshot, owner);
  if (drift) return supersedePreflightDrift(input, caseId, owner, drift);
  await reserveDispatch(input, caseId, record, owner, expectedSequence);
  return RETRY;
}

async function supersedePreflightDrift(
  input: MaterializationInput,
  caseId: string,
  owner: Extract<EvalRepairOwnerResolution, { status: 'resolved' }>,
  drift: 'owner' | 'authorization' | 'target',
): Promise<MaterializationAdvance> {
  const superseded = await supersedeEvalRepairApproval({
    eventLog: input.options.eventLog,
    caseId,
    proposalId: input.proposalId,
    owner,
    drift,
    occurredAt: input.now(),
  });
  if (superseded.status === 'superseded') return superseded;
  if (superseded.status === 'materialization_in_progress' || superseded.status === 'not_eligible') return RETRY;
  const committed = await locateEvalRepairApproval(input.options.eventLog, input.proposalId);
  if (!committed?.record.materialization) throw new Error('materialized Approval receipt disappeared');
  return { status: 'duplicate', receipt: receiptFrom(committed.record) };
}

function recoveredSupersession(record: EvalRepairApprovalRecord): EvalRepairMaterializeResult {
  if (!record.supersededByCaseActionRef || !record.supersessionDrift) {
    throw new Error('superseded Approval is missing its linked fresh cycle');
  }
  return {
    status: 'superseded',
    freshCaseActionRef: record.supersededByCaseActionRef,
    drift: record.supersessionDrift,
  };
}

async function reserveDispatch(
  input: MaterializationInput,
  caseId: string,
  record: EvalRepairApprovalRecord,
  owner: Extract<EvalRepairOwnerResolution, { status: 'resolved' }>,
  expectedSequence: number,
): Promise<void> {
  const approvalRef = record.approvalRef;
  if (!approvalRef) throw new Error('accepted Approval is missing its canonical decision ref');
  const dispatchSnapshot = snapshot(owner);
  const dispatchId = deriveDispatchId(record.proposal.proposalId, dispatchSnapshot);
  const started: EvalLifecycleEvent = {
    eventId: `f266:${caseId}:proposal:${record.proposal.proposalId}:materialization-started:${dispatchId}`,
    caseId,
    verdictId: record.proposal.verdictId,
    domainId: record.proposal.domainId,
    type: 'approval_materialization_started',
    actor: { kind: 'automation', id: 'eval-repair-materializer' },
    occurredAt: input.now(),
    reason: 'reserved one owner-validated canonical repair dispatch',
    refs: [
      { kind: 'other', availability: 'available', value: approvalRef.ownerStateRef },
      { kind: 'other', availability: 'available', value: dispatchSnapshot.ownerAuthorizationRef.ownerStateRef },
      { kind: 'other', availability: 'available', value: dispatchSnapshot.targetVersionRef.ownerStateRef },
    ],
    proposalId: record.proposal.proposalId,
    approvalRef,
    requestSnapshot: record.proposal.requestSnapshot,
    dispatchSnapshot,
    dispatchId,
  };
  await input.options.eventLog.append(started, expectedSequence);
}

async function dispatchReserved(
  input: MaterializationInput,
  caseId: string,
  record: EvalRepairApprovalRecord,
): Promise<EvalRepairMaterializeResult> {
  const reserved = record.materializationAttempt;
  if (!reserved) throw new Error('canonical repair dispatch is not reserved');
  const dispatchInput: CanonicalRepairDispatchInput = {
    dispatchId: reserved.dispatchId,
    caseRef: ownerTruthRefV1Schema.parse({
      ownerFeatureId: 'F266',
      ownerStateRef: `eval-case:${caseId}`,
      version: record.proposal.verdictId,
    }),
    proposalRef: ownerTruthRefV1Schema.parse({
      ownerFeatureId: 'F266',
      ownerStateRef: `eval-repair-proposal:${record.proposal.proposalId}`,
    }),
    approvalRef: ownerTruthRefV1Schema.parse(reserved.approvalRef),
    ...snapshot(reserved.dispatchSnapshot),
  };
  const outcome = await input.options.canonicalRepairDispatcher.materialize(dispatchInput);
  if (outcome.status === 'blocked') {
    ownerTruthRefV1Schema.parse(outcome.blockerRef);
    return { status: 'blocked', reason: outcome.reason };
  }
  if (outcome.status === 'stale') return supersedeRejectedDispatch(input, caseId, record, outcome);
  validateDispatchReceipt(outcome.receipt);
  return commitMaterializationReceipt(input, caseId, record.proposal.proposalId, outcome.receipt);
}

async function supersedeRejectedDispatch(
  input: MaterializationInput,
  caseId: string,
  record: EvalRepairApprovalRecord,
  outcome: Extract<CanonicalRepairDispatchOutcome, { status: 'stale' }>,
): Promise<EvalRepairMaterializeResult> {
  const reserved = record.materializationAttempt;
  if (!reserved) throw new Error('stale dispatch has no durable reservation');
  const currentSnapshot = snapshot(outcome.currentSnapshot);
  const dispatchRejectionRef = ownerTruthRefV1Schema.parse(outcome.rejectionRef);
  const drift = classifyDrift(reserved.dispatchSnapshot, currentSnapshot);
  if (!drift) throw new Error('canonical repair owner rejected an unchanged dispatch snapshot');
  const superseded = await supersedeEvalRepairApproval({
    eventLog: input.options.eventLog,
    caseId,
    proposalId: record.proposal.proposalId,
    owner: currentSnapshot,
    drift,
    occurredAt: input.now(),
    dispatchRejectionRef,
  });
  if (superseded.status === 'superseded') return superseded;
  if (superseded.status === 'materialized') {
    throw new Error('canonical repair owner returned conflicting terminal outcomes for one dispatchId');
  }
  return { status: 'blocked', reason: 'approval_materialization_in_progress' };
}

async function commitMaterializationReceipt(
  input: MaterializationInput,
  caseId: string,
  proposalId: string,
  receipt: CanonicalRepairDispatchReceipt,
): Promise<EvalRepairMaterializeResult> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const located = await locateEvalRepairApproval(input.options.eventLog, proposalId);
    if (!located || located.caseId !== caseId) throw new Error('reserved Approval disappeared before receipt commit');
    if (located.record.materialization) {
      const canonicalReceipt = receiptFrom(located.record);
      assertDispatchReceiptMatches(receipt, canonicalReceipt);
      return { status: 'duplicate', receipt: canonicalReceipt };
    }
    if (located.record.supersededByCaseActionRef) {
      throw new Error('canonical repair owner returned materialized after a stale rejection for one dispatchId');
    }
    const reserved = located.record.materializationAttempt;
    if (!reserved) throw new Error('materialization receipt has no durable dispatch reservation');
    const event: EvalLifecycleEvent = {
      eventId: `f266:${caseId}:proposal:${proposalId}:materialized:${reserved.dispatchId}`,
      caseId,
      verdictId: located.record.proposal.verdictId,
      domainId: located.record.proposal.domainId,
      type: 'approval_materialized',
      actor: { kind: 'automation', id: 'eval-repair-materializer' },
      occurredAt: input.now(),
      reason: 'fresh accepted Approval materialized one canonical repair custody',
      refs: [
        { kind: 'task', availability: 'available', value: receipt.taskRef.ownerStateRef },
        { kind: 'other', availability: 'available', value: receipt.leaseRef.ownerStateRef },
        { kind: 'other', availability: 'available', value: receipt.custodyReceiptRef.ownerStateRef },
      ],
      proposalId,
      approvalRef: reserved.approvalRef,
      requestSnapshot: reserved.requestSnapshot,
      dispatchSnapshot: reserved.dispatchSnapshot,
      dispatchId: reserved.dispatchId,
      ...receipt,
    };
    const appended = await input.options.eventLog.append(event, located.expectedSequence);
    if (appended.outcome === 'conflict' || appended.outcome === 'duplicate') continue;
    return { status: 'materialized', receipt };
  }
  throw new Error(`F266 materialization receipt CAS did not converge for ${proposalId}`);
}
