import { loadDomains } from './hub/eval-hub-read-model.js';
import { type LifecycleRootArtifact, scanLifecycleRootArtifacts } from './publish-verdict/lifecycle-root-artifact.js';
import type { ReevalCaseRoot } from './reeval-case.js';

export type LifecycleRootV2 = Extract<LifecycleRootArtifact, { schemaVersion: 2 }>;

export interface ResolvedReevalCaseRoot {
  requestedRoot: LifecycleRootV2;
  roots: readonly LifecycleRootV2[];
  projectorRoot: ReevalCaseRoot;
}

export function loadReevalCaseRoot(
  harnessFeedbackRoot: string,
  verdictId: string,
  assignedEvalCatIdOverride?: string,
): ResolvedReevalCaseRoot | undefined {
  const artifacts = scanLifecycleRootArtifacts(harnessFeedbackRoot);
  const requested = artifacts.find(
    (artifact): artifact is LifecycleRootV2 => artifact.schemaVersion === 2 && artifact.verdictId === verdictId,
  );
  if (!requested) return undefined;

  const roots = artifacts
    .filter(
      (artifact): artifact is LifecycleRootV2 => artifact.schemaVersion === 2 && artifact.caseId === requested.caseId,
    )
    .sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.verdictId.localeCompare(right.verdictId),
    );
  for (const candidate of roots) {
    if (
      candidate.domainId !== requested.domainId ||
      candidate.findingKey !== requested.findingKey ||
      candidate.ownerAsk.targetOwnerCatId !== requested.ownerAsk.targetOwnerCatId
    ) {
      throw new Error(`case ${requested.caseId} contains incompatible immutable lifecycle roots`);
    }
  }

  const domain = loadDomains(harnessFeedbackRoot).get(requested.domainId);
  if (!domain)
    throw new Error(`lifecycle case ${requested.caseId} references unregistered domain ${requested.domainId}`);
  return {
    requestedRoot: requested,
    roots,
    projectorRoot: {
      caseId: requested.caseId,
      domainId: requested.domainId,
      targetOwnerCatId: requested.ownerAsk.targetOwnerCatId,
      assignedEvalCatId: assignedEvalCatIdOverride ?? domain.evalCat.catId,
      reevalWithinHours: domain.sla.reevalWithinHours,
      cycles: roots.map((root) => ({ verdictId: root.verdictId, createdAt: root.createdAt, verdict: root.verdict })),
    },
  };
}
