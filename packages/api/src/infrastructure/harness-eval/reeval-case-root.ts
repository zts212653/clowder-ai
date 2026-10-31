import { loadDomains } from './hub/eval-hub-read-model.js';
import { loadLifecycleRootsWithLegacyCases } from './legacy-reeval-case-migration.js';
import type { LifecycleRootArtifact } from './publish-verdict/lifecycle-root-artifact.js';
import type { ReevalCaseRoot } from './reeval-case.js';
import { compareReevalCycles } from './reeval-case-cycle-order.js';

export type LifecycleRootV2 = Extract<LifecycleRootArtifact, { schemaVersion: 2 }>;
export type LifecycleRootV3 = Extract<LifecycleRootArtifact, { schemaVersion: 3 }>;
export type LifecycleCaseRoot = LifecycleRootV2 | LifecycleRootV3;

export const FRICTION_LIFECYCLE_V3_QUARANTINE_REASON = 'phase_c_cutover_incomplete' as const;

export interface FrictionLifecycleV3QuarantineDiagnostic {
  error: 'friction_lifecycle_v3_quarantined';
  status: 'known-but-quarantined';
  reason: typeof FRICTION_LIFECYCLE_V3_QUARANTINE_REASON;
  effects: {
    openCase: false;
    approvalProposal: false;
    approvalCard: false;
    task: false;
    f167Lease: false;
  };
}

export interface ResolvedReevalCaseRoot {
  requestedRoot: LifecycleCaseRoot;
  roots: readonly LifecycleCaseRoot[];
  projectorRoot: ReevalCaseRoot;
}

export type ReevalCaseRootClassification =
  | { status: 'available'; value: ResolvedReevalCaseRoot }
  | {
      status: 'known-but-quarantined';
      root: LifecycleRootV3;
      diagnostic: FrictionLifecycleV3QuarantineDiagnostic;
    }
  | { status: 'not-found' };

export function frictionLifecycleV3QuarantineDiagnostic(): FrictionLifecycleV3QuarantineDiagnostic {
  return {
    error: 'friction_lifecycle_v3_quarantined',
    status: 'known-but-quarantined',
    reason: FRICTION_LIFECYCLE_V3_QUARANTINE_REASON,
    effects: {
      openCase: false,
      approvalProposal: false,
      approvalCard: false,
      task: false,
      f167Lease: false,
    },
  };
}

export function classifyReevalCaseRoot(
  harnessFeedbackRoot: string,
  verdictId: string,
  assignedEvalCatIdOverride?: string,
  frictionV3Cutover?: { lifecycleVersion: 1 },
): ReevalCaseRootClassification {
  const artifacts = loadLifecycleRootsWithLegacyCases(harnessFeedbackRoot);
  const quarantined = artifacts.find(
    (artifact): artifact is LifecycleRootV3 => artifact.schemaVersion === 3 && artifact.verdictId === verdictId,
  );
  if (quarantined && frictionV3Cutover?.lifecycleVersion !== 1) {
    return {
      status: 'known-but-quarantined',
      root: quarantined,
      diagnostic: frictionLifecycleV3QuarantineDiagnostic(),
    };
  }

  const requested = artifacts.find(
    (artifact): artifact is LifecycleCaseRoot =>
      (artifact.schemaVersion === 2 || artifact.schemaVersion === 3) && artifact.verdictId === verdictId,
  );
  if (!requested) return { status: 'not-found' };

  const roots = artifacts
    .filter(
      (artifact): artifact is LifecycleCaseRoot =>
        (artifact.schemaVersion === 2 || artifact.schemaVersion === 3) && artifact.caseId === requested.caseId,
    )
    .sort(compareReevalCycles);
  for (const candidate of roots) {
    if (
      candidate.domainId !== requested.domainId ||
      candidate.findingKey !== requested.findingKey ||
      candidate.harnessUnderEval.featureId !== requested.harnessUnderEval.featureId
    ) {
      throw new Error(`case ${requested.caseId} contains incompatible immutable lifecycle roots`);
    }
  }

  const domain = loadDomains(harnessFeedbackRoot).get(requested.domainId);
  if (!domain)
    throw new Error(`lifecycle case ${requested.caseId} references unregistered domain ${requested.domainId}`);
  return {
    status: 'available',
    value: {
      requestedRoot: requested,
      roots,
      projectorRoot: {
        caseId: requested.caseId,
        domainId: requested.domainId,
        targetOwnerCatId:
          requested.schemaVersion === 3 ? requested.repairTarget.ownerCatId : domain.handoffTargetResolver.ownerCatId,
        assignedEvalCatId: assignedEvalCatIdOverride ?? domain.evalCat.catId,
        reevalWithinHours: domain.sla.reevalWithinHours,
        cycles: roots.map((root) => ({ verdictId: root.verdictId, createdAt: root.createdAt, verdict: root.verdict })),
      },
    },
  };
}

export function loadReevalCaseRoot(
  harnessFeedbackRoot: string,
  verdictId: string,
  assignedEvalCatIdOverride?: string,
  frictionV3Cutover?: { lifecycleVersion: 1 },
): ResolvedReevalCaseRoot | undefined {
  const classification = classifyReevalCaseRoot(
    harnessFeedbackRoot,
    verdictId,
    assignedEvalCatIdOverride,
    frictionV3Cutover,
  );
  return classification.status === 'available' ? classification.value : undefined;
}
