import { type PawFeelContinuationProjection, refIdentity } from '@cat-cafe/shared';
import type { EvalLifecycleEvent } from '../../reeval-closure-schema.js';
import type { PawFeelCurrentSourceFinding } from './source-case-follow-up.js';

function compactUnique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function projectPawFeelSourceOutcome(
  selected: PawFeelCurrentSourceFinding,
  outcome: Extract<EvalLifecycleEvent, { type: 'repair_outcome_recorded' }>,
): PawFeelContinuationProjection {
  const events = selected.events ?? [];
  const materialized = [...events]
    .reverse()
    .find(
      (event): event is Extract<EvalLifecycleEvent, { type: 'approval_materialized' }> =>
        event.type === 'approval_materialized' &&
        event.caseId === selected.root.caseId &&
        event.proposalId === outcome.proposalId,
    );
  const intervention = [...events]
    .reverse()
    .find(
      (event) =>
        (event.type === 'repair_intervention_changed' || event.type === 'repair_intervention_no_change') &&
        event.caseId === selected.root.caseId &&
        event.proposalId === outcome.proposalId &&
        refIdentity(event.interventionReceiptRef) === refIdentity(outcome.interventionReceiptRef),
    );
  const changed = intervention?.type === 'repair_intervention_changed' ? intervention : undefined;
  return {
    kind: outcome.outcome === 'effective_keep' ? 'verified_outcome' : 'observe',
    evidenceRefs: compactUnique([
      selected.artifactRef,
      outcome.caseActionRef,
      outcome.proposalId,
      outcome.approvalRef.ownerStateRef,
      materialized?.taskRef.ownerStateRef,
      materialized?.leaseRef.ownerStateRef,
      materialized?.custodyReceiptRef.ownerStateRef,
      outcome.interventionReceiptRef.ownerStateRef,
      changed?.assetVersionRef.ownerStateRef,
      changed ? `main-commit:${changed.mainCommitSha}` : undefined,
      changed?.loadedRuntimeRef.ownerStateRef,
      outcome.loadedRuntimeRef?.ownerStateRef,
      outcome.outcomeReceiptRef.ownerStateRef,
      outcome.reevaluationRef.ownerStateRef,
      outcome.freshnessProofRef.ownerStateRef,
    ]),
    caseActionRef: outcome.caseActionRef,
    proposalId: outcome.proposalId,
    ...(materialized
      ? { taskId: materialized.taskRef.ownerStateRef, leaseId: materialized.leaseRef.ownerStateRef }
      : {}),
  };
}
