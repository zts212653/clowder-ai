import { type OwnerTruthRefV1, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import {
  deriveFreshCaseActionRef,
  type EvalRepairMaterializeResult,
  snapshot,
} from './eval-repair-approval-contracts.js';
import {
  type EvalRepairApprovalRecord,
  type EvalRepairApprovalSnapshot,
  projectEvalRepairApprovals,
} from './eval-repair-approval-projection.js';
import type { IReevalClosureEventLog } from './reeval-closure-event-log.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

type SupersedeResult =
  | Extract<EvalRepairMaterializeResult, { status: 'superseded' }>
  | { status: 'materialization_in_progress' }
  | { status: 'materialized' }
  | { status: 'not_eligible' };

export async function supersedeEvalRepairApproval(input: {
  eventLog: IReevalClosureEventLog;
  caseId: string;
  proposalId: string;
  owner: EvalRepairApprovalSnapshot;
  drift: 'owner' | 'authorization' | 'target';
  occurredAt: string;
  dispatchRejectionRef?: OwnerTruthRefV1;
}): Promise<SupersedeResult> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const events = await input.eventLog.read(input.caseId);
    const record = projectEvalRepairApprovals(events).proposals.find(
      (candidate) => candidate.proposal.proposalId === input.proposalId,
    );
    if (!record) throw new Error(`Approval proposal not found for supersession: ${input.proposalId}`);
    const existing = existingSupersessionOutcome(record, input);
    if (existing) return existing;
    const freshCaseActionRef = deriveFreshCaseActionRef(record, input.owner);
    const event: EvalLifecycleEvent = {
      eventId: `f266:${input.caseId}:proposal:${record.proposal.proposalId}:superseded:${freshCaseActionRef}`,
      caseId: input.caseId,
      verdictId: record.proposal.verdictId,
      domainId: record.proposal.domainId,
      type: 'approval_superseded',
      actor: { kind: 'automation', id: 'eval-repair-approval' },
      occurredAt: input.occurredAt,
      reason: `Approval snapshot drifted at ${input.drift}; fresh Approval is required`,
      refs: [
        { kind: 'other', availability: 'available', value: freshCaseActionRef },
        ...(input.dispatchRejectionRef
          ? ([
              {
                kind: 'other',
                availability: 'available',
                value: input.dispatchRejectionRef.ownerStateRef,
              },
            ] as const)
          : []),
      ],
      proposalId: record.proposal.proposalId,
      drift: input.drift,
      freshCaseActionRef,
      requestSnapshot: snapshot(input.owner),
      ...(input.dispatchRejectionRef
        ? { dispatchRejectionRef: ownerTruthRefV1Schema.parse(input.dispatchRejectionRef) }
        : {}),
    };
    const appended = await input.eventLog.append(event, events.length);
    if (appended.outcome === 'conflict') continue;
    return { status: 'superseded', freshCaseActionRef, drift: input.drift };
  }
  throw new Error(`F266 Approval supersession CAS did not converge for ${input.caseId}`);
}

function existingSupersessionOutcome(
  record: EvalRepairApprovalRecord,
  input: { drift: 'owner' | 'authorization' | 'target'; dispatchRejectionRef?: OwnerTruthRefV1 },
): SupersedeResult | undefined {
  if (record.supersededByCaseActionRef) {
    return {
      status: 'superseded',
      freshCaseActionRef: record.supersededByCaseActionRef,
      drift: record.supersessionDrift ?? input.drift,
    };
  }
  if (record.materialization) return { status: 'materialized' };
  if (record.materializationAttempt && !input.dispatchRejectionRef) {
    return { status: 'materialization_in_progress' };
  }
  if (record.lifecycle.resolution !== 'open' && record.lifecycle.resolution !== 'accepted') {
    return { status: 'not_eligible' };
  }
  return undefined;
}
