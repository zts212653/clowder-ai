import type { PawFeelDispositionProjection } from '@cat-cafe/shared';
import type { FrictionAnalysisFindingV1 } from '../../friction/friction-finding-artifact.js';
import type { LifecycleRootArtifact } from '../../publish-verdict/lifecycle-root-artifact.js';
import type { EvalLifecycleEvent } from '../../reeval-closure-schema.js';
import type { VerifiedPawFeelSourceIdentityContext } from '../direct-repair/direct-repair-source.js';
import type { PawFeelSourceCaseFollowUp } from './follow-up-resolver.js';
import { projectPawFeelSourceOutcome } from './source-case-outcome-projection.js';

export interface PawFeelMatchingSourceFinding {
  artifactRef: string;
  caseActionRef?: string;
  stale: boolean;
  finding?: FrictionAnalysisFindingV1;
  root?: Extract<LifecycleRootArtifact, { schemaVersion: 3 }>;
  events?: EvalLifecycleEvent[];
  completed?: boolean;
}

export type PawFeelCurrentSourceFinding = PawFeelMatchingSourceFinding & {
  finding: FrictionAnalysisFindingV1;
  root: Extract<LifecycleRootArtifact, { schemaVersion: 3 }>;
};

export function defaultPawFeelAnalysisRecheckAt(discoveredAt: string): string {
  return new Date(Date.parse(discoveredAt) + 72 * 3_600_000).toISOString();
}

function currentFinding(candidate: PawFeelMatchingSourceFinding): candidate is PawFeelCurrentSourceFinding {
  return !candidate.stale && Boolean(candidate.root && candidate.finding);
}

function compactUnique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function proposalFollowUp(selected: PawFeelCurrentSourceFinding): PawFeelSourceCaseFollowUp {
  const events = selected.events ?? [];
  const proposed = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === 'approval_proposed' &&
        event.caseId === selected.root.caseId &&
        event.caseActionRef === selected.caseActionRef,
    );
  if (proposed?.type !== 'approval_proposed') {
    return {
      resolution: 'open',
      continuation: {
        kind: 'approval_required',
        evidenceRefs: [selected.artifactRef],
        caseActionRef: selected.caseActionRef,
      },
    };
  }
  const decision = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === 'approval_decided' &&
        event.caseId === selected.root.caseId &&
        event.proposalId === proposed.proposalId,
    );
  const materialized = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === 'approval_materialized' &&
        event.caseId === selected.root.caseId &&
        event.proposalId === proposed.proposalId,
    );
  if (materialized?.type === 'approval_materialized') {
    return {
      resolution: 'open',
      continuation: {
        kind: 'repair_active',
        evidenceRefs: compactUnique([
          selected.artifactRef,
          proposed.proposalId,
          materialized.approvalRef.ownerStateRef,
          materialized.taskRef.ownerStateRef,
          materialized.leaseRef.ownerStateRef,
          materialized.custodyReceiptRef.ownerStateRef,
        ]),
        proposalId: proposed.proposalId,
        taskId: materialized.taskRef.ownerStateRef,
        leaseId: materialized.leaseRef.ownerStateRef,
      },
    };
  }
  if (decision?.type === 'approval_decided' && decision.resolution === 'accepted') {
    return {
      resolution: 'open',
      continuation: {
        kind: 'dispatch_pending',
        evidenceRefs: compactUnique([selected.artifactRef, proposed.proposalId, decision.approvalRef.ownerStateRef]),
        proposalId: proposed.proposalId,
      },
    };
  }
  return {
    resolution: 'open',
    continuation: {
      kind: 'approval_required',
      evidenceRefs: [selected.artifactRef, proposed.proposalId],
      caseActionRef: selected.caseActionRef,
      proposalId: proposed.proposalId,
    },
  };
}

export function projectPawFeelSourceCaseFollowUp(input: {
  projection: PawFeelDispositionProjection;
  source: VerifiedPawFeelSourceIdentityContext;
  matches: readonly PawFeelMatchingSourceFinding[];
}): PawFeelSourceCaseFollowUp | null {
  if (input.matches.length === 0) {
    if (input.projection.state !== 'seen') return null;
    return {
      resolution: 'open',
      continuation: {
        kind: 'analysis_required',
        evidenceRefs: [input.source.sourceSignalRef.ownerStateRef],
      },
      resumeAt: defaultPawFeelAnalysisRecheckAt(input.projection.discoveredAt),
    };
  }
  const current = input.matches.filter(currentFinding);
  if (current.length > 1) {
    return {
      resolution: 'open',
      continuation: {
        kind: 'analysis_ambiguous',
        evidenceRefs: current.map((candidate) => candidate.artifactRef).sort(),
      },
    };
  }
  const selected = current[0];
  if (!selected) {
    return {
      resolution: 'open',
      continuation: {
        kind: 'analysis_stale',
        evidenceRefs: input.matches.map((candidate) => candidate.artifactRef).sort(),
      },
    };
  }
  const outcome = [...(selected.events ?? [])]
    .reverse()
    .find(
      (event) =>
        event.type === 'repair_outcome_recorded' &&
        event.caseId === selected.root.caseId &&
        event.verdictId === selected.root.verdictId &&
        event.caseActionRef === selected.caseActionRef,
    );
  if (outcome?.type === 'repair_outcome_recorded') {
    const continuation = projectPawFeelSourceOutcome(selected, outcome);
    return outcome.outcome === 'effective_keep'
      ? { resolution: 'resolved', resolvedAt: outcome.occurredAt, continuation }
      : {
          resolution: 'open',
          continuation,
          resumeAt: selected.root.acceptanceReevalPlan.nextEvalAt,
        };
  }
  if (selected.finding.analysisDisposition !== 'repair') {
    return {
      resolution: 'open',
      continuation: { kind: 'observe', evidenceRefs: [selected.artifactRef] },
      resumeAt: selected.root.acceptanceReevalPlan.nextEvalAt,
    };
  }
  return proposalFollowUp(selected);
}
