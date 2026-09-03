import { createHash } from 'node:crypto';
import type { LifecycleRootArtifact } from './publish-verdict/lifecycle-root-artifact.js';
import type { PlannedReevalClosureAppend, ReevalCaseReconcileSubject } from './reeval-closure-reconciler.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

const RECONCILER_ACTOR = { kind: 'automation', id: 'eval-verdict-closure-reconciler' } as const;

export function planEvalRepairReadyEvents(
  subject: ReevalCaseReconcileSubject,
  working: readonly EvalLifecycleEvent[],
  now: string,
): PlannedReevalClosureAppend[] {
  const planned: PlannedReevalClosureAppend[] = [];
  for (const root of subject.roots) {
    if (
      root.schemaVersion !== 3 ||
      root.findingBinding.approvalRequirement.kind !== 'required' ||
      working.some((event) => event.type === 'case_ready_for_proposal' && event.verdictId === root.verdictId)
    ) {
      continue;
    }
    const caseActionRef = deriveEvalRepairCaseActionRef(root);
    const event: EvalLifecycleEvent = {
      eventId: `f266:${subject.caseRoot.caseId}:cycle:${root.verdictId}:ready:${caseActionRef}`,
      caseId: subject.caseRoot.caseId,
      verdictId: root.verdictId,
      domainId: root.domainId,
      type: 'case_ready_for_proposal',
      actor: RECONCILER_ACTOR,
      occurredAt: now,
      reason: 'immutable friction finding is ready for owner-backed Approval proposal',
      refs: [{ kind: 'other', availability: 'available', value: root.findingBinding.artifactRef }],
      caseActionRef,
      findingArtifactRef: root.findingBinding.artifactRef,
    };
    planned.push({ event, expectedSequence: working.length + planned.length });
  }
  return planned;
}

export function isEvalRepairAwaitingApproval(
  root: Extract<LifecycleRootArtifact, { schemaVersion: 2 | 3 }>,
  activeVerdictId: string,
  events: readonly EvalLifecycleEvent[],
): boolean {
  return (
    root.schemaVersion === 3 &&
    !events.some((event) => event.type === 'approval_materialized' && event.verdictId === activeVerdictId)
  );
}

export function deriveEvalRepairCaseActionRef(root: Extract<LifecycleRootArtifact, { schemaVersion: 3 }>): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        root.caseId,
        root.verdictId,
        root.findingBinding.artifactRef,
        root.findingBinding.artifactSha256,
        root.repairTarget.version,
      ]),
      'utf8',
    )
    .digest('hex');
  return `case-action:f266:${digest}`;
}
