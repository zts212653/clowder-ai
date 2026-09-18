import type { EvalLifecycleSpace } from '../lifecycle-space.js';
import type { LifecycleRootArtifact } from '../publish-verdict/lifecycle-root-artifact.js';
import { projectReevalCase } from '../reeval-case.js';
import { loadReevalCaseRoot } from '../reeval-case-root.js';
import { projectReevalClosure, type ReevalClosureRoot } from '../reeval-closure.js';
import type { EvalLifecycleEvent } from '../reeval-closure-schema.js';
import { projectLifecyclePresentation } from './eval-hub-lifecycle-debt.js';
import type { EvalHubItem, EvalHubLifecycleView } from './eval-hub-read-model-types.js';

/**
 * F266 lifecycle views for Eval Hub items: pure projections from a verdict's
 * immutable root and its canonical events. The space a case root is resolved in is
 * always the item's own; see `eval-hub-lifecycle-projection.ts`.
 */

export interface ResolvedEvalVerdictLifecycleRoot {
  artifact: LifecycleRootArtifact;
  projectorRoot: ReevalClosureRoot;
}

export function availableCaseLifecycle(
  item: EvalHubItem,
  space: EvalLifecycleSpace,
  root: ResolvedEvalVerdictLifecycleRoot,
  events: readonly EvalLifecycleEvent[],
  generatedAt: string,
  assignedEvalCatIds?: ReadonlyMap<string, string>,
): EvalHubLifecycleView {
  if (root.artifact.schemaVersion !== 2) throw new Error(`verdict ${item.id} does not belong to a stable case`);
  const resolved = loadReevalCaseRoot(space, item.id, assignedEvalCatIds?.get(root.artifact.domainId));
  if (!resolved) throw new Error(`stable case root unavailable for verdict ${item.id}`);
  const projection = projectReevalCase(resolved.projectorRoot, events);
  const activeRoot = resolved.roots.find((candidate) => candidate.verdictId === projection.activeVerdictId);
  const presentation = projectLifecyclePresentation(projection, generatedAt, activeRoot);
  return {
    availability: 'available',
    closureStatus: projection.status,
    ...presentation,
    sequence: projection.sequence,
    caseId: projection.caseId,
    activeVerdictId: projection.activeVerdictId,
    observedVerdictIds: [...projection.observedVerdictIds],
    targetOwnerCatId: projection.targetOwnerCatId,
    ...(projection.lifecycleOwnerCatId ? { lifecycleOwnerCatId: projection.lifecycleOwnerCatId } : {}),
    ...(projection.taskId ? { taskId: projection.taskId } : {}),
    ...(projection.leaseId ? { leaseId: projection.leaseId } : {}),
    ...(projection.leaseGeneration ? { leaseGeneration: projection.leaseGeneration } : {}),
    ...(projection.responsibilityBlocker
      ? {
          responsibilityBlocker: {
            ...projection.responsibilityBlocker,
            candidateThreadIds: [...projection.responsibilityBlocker.candidateThreadIds],
          },
        }
      : {}),
    ...(projection.custodyDispatchBlocker ? { custodyDispatchBlocker: { ...projection.custodyDispatchBlocker } } : {}),
    ...(projection.mainCommitSha ? { mainCommitSha: projection.mainCommitSha } : {}),
    ...(projection.liveCommitSha ? { liveCommitSha: projection.liveCommitSha } : {}),
    ...(projection.reevalTaskId ? { reevalTaskId: projection.reevalTaskId } : {}),
    ...(projection.reevalLeaseId ? { reevalLeaseId: projection.reevalLeaseId } : {}),
    ...(projection.reevalLeaseGeneration ? { reevalLeaseGeneration: projection.reevalLeaseGeneration } : {}),
    ownerResponseRefs: [...projection.ownerResponseRefs],
    planRefs: [...projection.planRefs],
    actionRefs: [...projection.actionRefs],
    reevalRefs: [...projection.reevalRefs],
    unavailableRefs: projection.refs.filter((ref) => ref.availability === 'unavailable'),
    ...(projection.closureReason ? { closureReason: projection.closureReason } : {}),
    diagnosisTarget: diagnosisTarget(item, root.artifact),
  };
}

function diagnosisTarget(item: EvalHubItem, artifact: LifecycleRootArtifact) {
  return {
    featureId: artifact.harnessUnderEval.featureId,
    componentId: artifact.harnessUnderEval.componentId,
    name: artifact.harnessUnderEval.name,
    attributionRefs: [...item.evidence.attributionRefs],
    metricRefs: [...item.evidence.metricRefs],
  };
}

export function availableLifecycle(
  item: EvalHubItem,
  root: ResolvedEvalVerdictLifecycleRoot,
  events: readonly EvalLifecycleEvent[],
  generatedAt: string,
): EvalHubLifecycleView {
  const projection = projectReevalClosure(root.projectorRoot, events);
  const presentation = projectLifecyclePresentation(projection, generatedAt);
  return {
    availability: 'available',
    closureStatus: projection.status,
    ...presentation,
    sequence: projection.sequence,
    targetOwnerCatId: projection.targetOwnerCatId,
    ...(projection.lifecycleOwnerCatId ? { lifecycleOwnerCatId: projection.lifecycleOwnerCatId } : {}),
    ownerResponseRefs: [...projection.ownerResponseRefs],
    planRefs: [...projection.planRefs],
    actionRefs: [...projection.actionRefs],
    reevalRefs: [...projection.reevalRefs],
    unavailableRefs: projection.refs.filter((ref) => ref.availability === 'unavailable'),
    ...(projection.closureReason ? { closureReason: projection.closureReason } : {}),
    diagnosisTarget: diagnosisTarget(item, root.artifact),
  };
}
