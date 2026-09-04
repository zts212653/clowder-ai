import {
  exactAssetVersionRefV1Schema,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import { locateEvalRepairApproval } from './eval-repair-approval-contracts.js';
import type { EvalRepairApprovalRecord } from './eval-repair-approval-projection.js';
import type {
  EvalRepairFreshOutcomeReceipt,
  EvalRepairOutcomeBlockReason,
  EvalRepairOutcomeCommandResult,
  EvalRepairOutcomeInput,
  EvalRepairOutcomeServiceOptions,
} from './eval-repair-outcome-contracts.js';
import { evalRepairCaseRef, evalRepairProposalRef } from './eval-repair-outcome-refs.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

type Blocked = Extract<EvalRepairOutcomeCommandResult, { status: 'blocked' }>;
type InterventionEvent = Extract<
  EvalLifecycleEvent,
  { type: 'repair_intervention_changed' | 'repair_intervention_no_change' }
>;

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
  return ref.ownerFeatureId === 'F266' && ref.ownerStateRef.startsWith(prefix)
    ? ref.ownerStateRef.slice(prefix.length) || undefined
    : undefined;
}

function parseInput(raw: EvalRepairOutcomeInput): EvalRepairOutcomeInput | undefined {
  try {
    return {
      caseRef: ownerTruthRefV1Schema.parse(raw.caseRef),
      proposalRef: ownerTruthRefV1Schema.parse(raw.proposalRef),
      approvalRef: ownerTruthRefV1Schema.parse(raw.approvalRef),
      ownerAuthorizationRef: ownerTruthRefV1Schema.parse(raw.ownerAuthorizationRef),
      targetVersionRef: exactAssetVersionRefV1Schema.parse(raw.targetVersionRef),
      interventionRef: ownerTruthRefV1Schema.parse(raw.interventionRef),
      interventionReceiptRef: ownerTruthRefV1Schema.parse(raw.interventionReceiptRef),
      outcomeReceiptRef: ownerTruthRefV1Schema.parse(raw.outcomeReceiptRef),
    };
  } catch {
    return undefined;
  }
}

function receiptMatches(receipt: EvalRepairFreshOutcomeReceipt, input: EvalRepairOutcomeInput): boolean {
  return (
    same(receipt.receiptRef, input.outcomeReceiptRef) &&
    same(receipt.caseRef, input.caseRef) &&
    same(receipt.proposalRef, input.proposalRef) &&
    same(receipt.approvalRef, input.approvalRef) &&
    same(receipt.ownerAuthorizationRef, input.ownerAuthorizationRef) &&
    same(receipt.targetVersionRef, input.targetVersionRef) &&
    same(receipt.interventionRef, input.interventionRef) &&
    same(receipt.interventionReceiptRef, input.interventionReceiptRef)
  );
}

function findIntervention(
  events: readonly EvalLifecycleEvent[],
  proposalId: string,
  receiptRef: OwnerTruthRefV1,
): InterventionEvent | undefined {
  return events.find(
    (event): event is InterventionEvent =>
      (event.type === 'repair_intervention_changed' || event.type === 'repair_intervention_no_change') &&
      event.proposalId === proposalId &&
      same(event.interventionReceiptRef, receiptRef),
  );
}

function findOutcome(events: readonly EvalLifecycleEvent[], proposalId: string, receiptRef: OwnerTruthRefV1) {
  return events.find(
    (event) =>
      event.type === 'repair_outcome_recorded' &&
      event.proposalId === proposalId &&
      same(event.outcomeReceiptRef, receiptRef),
  );
}

function findAnyOutcome(events: readonly EvalLifecycleEvent[], proposalId: string) {
  return events.find((event) => event.type === 'repair_outcome_recorded' && event.proposalId === proposalId);
}

function canonicalBindingBlock(
  record: EvalRepairApprovalRecord,
  parsed: EvalRepairOutcomeInput,
  caseId: string,
  proposalId: string,
): Blocked | undefined {
  if (!record.proposal.ownerLineage) return blocked('binding_missing');
  if (!same(parsed.caseRef, evalRepairCaseRef(caseId, record.proposal.verdictId))) return blocked('case_mismatch');
  if (!same(parsed.proposalRef, evalRepairProposalRef(proposalId))) return blocked('proposal_mismatch');
  if (!record.approvalRef || !same(parsed.approvalRef, record.approvalRef)) return blocked('approval_mismatch');
  if (!same(parsed.ownerAuthorizationRef, record.proposal.requestSnapshot.ownerAuthorizationRef)) {
    return blocked('authorization_mismatch');
  }
  if (!same(parsed.targetVersionRef, record.proposal.requestSnapshot.targetVersionRef)) {
    return blocked('target_mismatch');
  }
  if (!same(parsed.interventionRef, record.proposal.ownerLineage.interventionRef)) {
    return blocked('intervention_mismatch');
  }
  return record.lifecycle.resolution === 'accepted' ? undefined : blocked('approval_not_accepted');
}

export async function recordFreshEvalRepairOutcome(input: {
  options: EvalRepairOutcomeServiceOptions;
  raw: EvalRepairOutcomeInput;
  now: () => string;
}): Promise<EvalRepairOutcomeCommandResult> {
  const parsed = parseInput(input.raw);
  if (!parsed) return blocked('binding_missing');
  const proposalId = proposalIdFrom(parsed.proposalRef);
  if (!proposalId) return blocked('proposal_mismatch');
  const located = await locateEvalRepairApproval(input.options.eventLog, proposalId);
  if (!located) return blocked('proposal_not_found');
  const record = located.record;
  const bindingBlocker = canonicalBindingBlock(record, parsed, located.caseId, proposalId);
  if (bindingBlocker) return bindingBlocker;
  const events = await input.options.eventLog.read(located.caseId);
  const existing = findOutcome(events, proposalId, parsed.outcomeReceiptRef);
  if (existing?.type === 'repair_outcome_recorded') {
    return { status: 'duplicate', outcome: existing.outcome };
  }
  if (findAnyOutcome(events, proposalId)) return blocked('idempotency_collision');
  const intervention = findIntervention(events, proposalId, parsed.interventionReceiptRef);
  if (!intervention) return blocked('intervention_receipt_missing');
  const receipt = await input.options.freshOutcomeOwner.resolve(parsed.outcomeReceiptRef);
  if (!receipt) return blocked('outcome_receipt_not_found');
  if (!receiptMatches(receipt, parsed)) return blocked('outcome_receipt_mismatch');
  const freshnessBlocker = validateFreshness(record.decidedAt, intervention, receipt);
  if (freshnessBlocker) return freshnessBlocker;
  const event = eventRecord(record, intervention, receipt, input.now());
  return commitOutcome(input.options.eventLog, located.caseId, proposalId, parsed.outcomeReceiptRef, event);
}

async function commitOutcome(
  eventLog: EvalRepairOutcomeServiceOptions['eventLog'],
  caseId: string,
  proposalId: string,
  receiptRef: OwnerTruthRefV1,
  event: Extract<EvalLifecycleEvent, { type: 'repair_outcome_recorded' }>,
): Promise<EvalRepairOutcomeCommandResult> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await eventLog.read(caseId);
    const exact = findOutcome(current, proposalId, receiptRef);
    if (exact?.type === 'repair_outcome_recorded') return { status: 'duplicate', outcome: exact.outcome };
    if (findAnyOutcome(current, proposalId)) return blocked('idempotency_collision');
    const appended = await eventLog.append(event, current.length);
    if (appended.outcome === 'appended') return { status: 'recorded', outcome: event.outcome };
  }
  throw new Error(`F266 fresh outcome CAS did not converge for ${caseId}`);
}

function validateFreshness(
  decidedAt: string | undefined,
  intervention: NonNullable<ReturnType<typeof findIntervention>>,
  receipt: EvalRepairFreshOutcomeReceipt,
): Blocked | undefined {
  const decisionTime = Date.parse(decidedAt ?? '');
  const measuredTime = Date.parse(receipt.measuredAt);
  if (!Number.isFinite(decisionTime) || !Number.isFinite(measuredTime) || measuredTime <= decisionTime) {
    return blocked('stale_outcome');
  }
  if (!receipt.uncontaminated) return blocked('contaminated_outcome');
  if (intervention.type === 'repair_intervention_changed') {
    return validateChangedFreshness(intervention, receipt, measuredTime);
  }
  return validateNoChangeFreshness(intervention, receipt, measuredTime);
}

function validateChangedFreshness(
  intervention: Extract<InterventionEvent, { type: 'repair_intervention_changed' }>,
  receipt: EvalRepairFreshOutcomeReceipt,
  measuredTime: number,
): Blocked | undefined {
  const loadedTime = Date.parse(intervention.loadedAt);
  if (!Number.isFinite(loadedTime) || measuredTime <= loadedTime) return blocked('preload_outcome');
  if (!receipt.loadedRuntimeRef || !same(receipt.loadedRuntimeRef, intervention.loadedRuntimeRef)) {
    return blocked('loaded_runtime_mismatch');
  }
  return undefined;
}

function validateNoChangeFreshness(
  intervention: Extract<InterventionEvent, { type: 'repair_intervention_no_change' }>,
  receipt: EvalRepairFreshOutcomeReceipt,
  measuredTime: number,
): Blocked | undefined {
  const recordedTime = Date.parse(intervention.recordedAt);
  if (!Number.isFinite(recordedTime) || measuredTime <= recordedTime) return blocked('stale_outcome');
  return receipt.loadedRuntimeRef ? blocked('loaded_runtime_mismatch') : undefined;
}

function eventRecord(
  record: EvalRepairApprovalRecord,
  intervention: NonNullable<ReturnType<typeof findIntervention>>,
  receipt: EvalRepairFreshOutcomeReceipt,
  occurredAt: string,
): Extract<EvalLifecycleEvent, { type: 'repair_outcome_recorded' }> {
  const ownerLineage = record.proposal.ownerLineage;
  if (!ownerLineage) throw new Error('validated owner lineage disappeared');
  return {
    eventId: `f266:${record.proposal.caseId}:outcome:${record.proposal.proposalId}`,
    caseId: record.proposal.caseId,
    verdictId: record.proposal.verdictId,
    domainId: record.proposal.domainId,
    type: 'repair_outcome_recorded',
    actor: { kind: 'automation', id: 'eval-repair-fresh-outcome-recorder' },
    occurredAt,
    reason: 'fresh owner-backed re-evaluation linked the exact intervention to one typed outcome',
    refs: [
      { kind: 'other', availability: 'available', value: ownerLineage.cycleRef.ownerStateRef },
      { kind: 'other', availability: 'available', value: record.proposal.findingArtifactRef },
      { kind: 'reeval', availability: 'available', value: receipt.reevaluationRef.ownerStateRef },
      { kind: 'other', availability: 'available', value: receipt.freshnessProofRef.ownerStateRef },
    ],
    proposalId: record.proposal.proposalId,
    caseActionRef: record.proposal.caseActionRef,
    approvalRef: receipt.approvalRef,
    requestSnapshot: record.proposal.requestSnapshot,
    ownerLineage,
    interventionReceiptRef: intervention.interventionReceiptRef,
    outcomeReceiptRef: receipt.receiptRef,
    reevaluationRef: receipt.reevaluationRef,
    freshnessProofRef: receipt.freshnessProofRef,
    outcome: receipt.outcome,
    ...(receipt.loadedRuntimeRef ? { loadedRuntimeRef: receipt.loadedRuntimeRef } : {}),
    measuredAt: receipt.measuredAt,
  };
}
