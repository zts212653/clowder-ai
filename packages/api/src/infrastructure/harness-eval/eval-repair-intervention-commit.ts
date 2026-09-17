import { type OwnerTruthRefV1, refIdentity } from '@cat-cafe/shared';
import { projectEvalRepairApprovals } from './eval-repair-approval-projection.js';
import type {
  EvalRepairOutcomeCommandResult,
  EvalRepairOutcomeServiceOptions,
} from './eval-repair-outcome-contracts.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

export type EvalRepairInterventionEvent = Extract<
  EvalLifecycleEvent,
  { type: 'repair_intervention_changed' | 'repair_intervention_no_change' }
>;

function same(left: unknown, right: unknown): boolean {
  try {
    return refIdentity(left as never) === refIdentity(right as never);
  } catch {
    return false;
  }
}

export function findIntervention(
  events: readonly EvalLifecycleEvent[],
  proposalId: string,
  receiptRef: OwnerTruthRefV1,
): EvalRepairInterventionEvent | undefined {
  return events.find(
    (event): event is EvalRepairInterventionEvent =>
      (event.type === 'repair_intervention_changed' || event.type === 'repair_intervention_no_change') &&
      event.proposalId === proposalId &&
      same(event.interventionReceiptRef, receiptRef),
  );
}

export function findAnyIntervention(events: readonly EvalLifecycleEvent[], proposalId: string) {
  return events.find(
    (event) =>
      (event.type === 'repair_intervention_changed' || event.type === 'repair_intervention_no_change') &&
      event.proposalId === proposalId,
  );
}

export function interventionKind(event: EvalRepairInterventionEvent): 'changed' | 'no_change' {
  return event.type === 'repair_intervention_changed' ? 'changed' : 'no_change';
}

function currentApprovalBlocker(
  events: readonly EvalLifecycleEvent[],
  proposalId: string,
): Extract<EvalRepairOutcomeCommandResult, { status: 'blocked' }> | undefined {
  const record = projectEvalRepairApprovals(events).proposals.find(
    (candidate) => candidate.proposal.proposalId === proposalId,
  );
  if (!record) return { status: 'blocked', reason: 'proposal_not_found' };
  if (record.supersededByCaseActionRef) {
    return {
      status: 'blocked',
      reason: 'approval_superseded',
      ...(record.supersessionDrift ? { drift: record.supersessionDrift } : {}),
      freshCaseActionRef: record.supersededByCaseActionRef,
    };
  }
  if (record.lifecycle.resolution !== 'accepted') {
    return { status: 'blocked', reason: 'approval_not_accepted' };
  }
  return undefined;
}

export async function commitIntervention(
  eventLog: EvalRepairOutcomeServiceOptions['eventLog'],
  caseId: string,
  proposalId: string,
  receiptRef: OwnerTruthRefV1,
  event: EvalRepairInterventionEvent,
): Promise<EvalRepairOutcomeCommandResult> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await eventLog.read(caseId);
    const exact = findIntervention(current, proposalId, receiptRef);
    if (exact) return { status: 'duplicate', kind: interventionKind(exact) };
    if (findAnyIntervention(current, proposalId)) {
      return { status: 'blocked', reason: 'idempotency_collision' };
    }
    const approvalBlocker = currentApprovalBlocker(current, proposalId);
    if (approvalBlocker) return approvalBlocker;
    const appended = await eventLog.append(event, current.length);
    if (appended.outcome === 'appended') return { status: 'recorded', kind: interventionKind(event) };
  }
  throw new Error(`F266 intervention receipt CAS did not converge for ${caseId}`);
}
