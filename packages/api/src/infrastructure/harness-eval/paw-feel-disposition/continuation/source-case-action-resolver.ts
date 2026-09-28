import { type PawFeelApprovalContinuationV1, type PawFeelDispositionProjection, refIdentity } from '@cat-cafe/shared';
import type { FrictionAnalysisFindingV1 } from '../../friction/friction-finding-artifact.js';
import { deriveEvalCaseId, type LifecycleRootArtifact } from '../../publish-verdict/lifecycle-root-artifact.js';
import type { IReevalClosureEventLog } from '../../reeval-closure-event-log.js';
import type { EvalLifecycleEvent } from '../../reeval-closure-schema.js';
import type {
  PawFeelDirectRepairSourceVerifier,
  VerifiedPawFeelSourceIdentityContext,
} from '../direct-repair/direct-repair-source.js';
import { derivePawFeelSourceSignalRef } from '../direct-repair/direct-repair-source.js';
import {
  loadPawFeelSourceFindingArtifactSnapshot,
  type PawFeelSourceFindingArtifactSnapshotRecord,
} from './source-case-artifact-snapshot.js';
import {
  defaultPawFeelAnalysisRecheckAt,
  type PawFeelMatchingSourceFinding,
  projectPawFeelSourceCaseFollowUp,
} from './source-case-follow-up.js';

type LifecycleReader = Pick<IReevalClosureEventLog, 'read'>;
type ArtifactIndex = Map<string, PawFeelSourceFindingArtifactSnapshotRecord[]>;

interface SourceCaseReadScope {
  artifacts?: Promise<ArtifactIndex>;
  caseEvents: Map<string, Promise<EvalLifecycleEvent[]>>;
  matches: Map<string, Promise<PawFeelMatchingSourceFinding[]>>;
}

export interface PawFeelSourceCaseActionResolverOptions {
  harnessFeedbackRoot: string;
  eventLog: LifecycleReader;
  sourceVerifier: Pick<PawFeelDirectRepairSourceVerifier, 'verifyIdentity'>;
}

function sourceJoinRef(sourceMessageId: string, markerIndex: number): string {
  return `source-message:${sourceMessageId}#${markerIndex}`;
}

function currentAction(
  events: readonly EvalLifecycleEvent[],
  caseId: string,
  verdictId: string,
  artifactRef: string,
): { caseActionRef?: string; stale: boolean; completed?: boolean } {
  const ready = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === 'case_ready_for_proposal' &&
        event.caseId === caseId &&
        event.verdictId === verdictId &&
        event.findingArtifactRef === artifactRef,
    );
  if (!ready || ready.type !== 'case_ready_for_proposal') return { stale: true };
  const outcome = events.find(
    (event) =>
      event.type === 'repair_outcome_recorded' &&
      event.caseId === caseId &&
      event.verdictId === verdictId &&
      event.caseActionRef === ready.caseActionRef,
  );
  if (outcome) return { caseActionRef: ready.caseActionRef, stale: false, completed: true };
  const proposal = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === 'approval_proposed' && event.caseId === caseId && event.caseActionRef === ready.caseActionRef,
    );
  if (proposal?.type === 'approval_proposed') {
    const superseded = events.find(
      (event) =>
        event.type === 'approval_superseded' && event.caseId === caseId && event.proposalId === proposal.proposalId,
    );
    if (superseded) return { stale: true };
    const decision = events.find(
      (event) =>
        event.type === 'approval_decided' && event.caseId === caseId && event.proposalId === proposal.proposalId,
    );
    if (decision?.type === 'approval_decided' && decision.resolution !== 'accepted') return { stale: true };
  }
  return { caseActionRef: ready.caseActionRef, stale: false };
}

function sameRepairTarget(
  finding: FrictionAnalysisFindingV1,
  root: Extract<LifecycleRootArtifact, { schemaVersion: 3 }>,
): boolean {
  return (
    finding.repairTargetResolution.status === 'resolved' &&
    JSON.stringify(finding.repairTargetResolution.target) === JSON.stringify(root.repairTarget)
  );
}

export class PawFeelSourceCaseActionResolver {
  constructor(
    private readonly options: PawFeelSourceCaseActionResolverOptions,
    private readonly readScope?: SourceCaseReadScope,
  ) {}

  snapshot(): PawFeelSourceCaseActionResolver {
    return new PawFeelSourceCaseActionResolver(this.options, { caseEvents: new Map(), matches: new Map() });
  }

  async resolve(input: {
    projection: PawFeelDispositionProjection;
    source?: VerifiedPawFeelSourceIdentityContext;
  }): Promise<PawFeelApprovalContinuationV1> {
    const source = input.source ?? (await this.options.sourceVerifier.verifyIdentity(input.projection));
    const expectedSourceRef = derivePawFeelSourceSignalRef(input.projection);
    if (
      refIdentity(source.sourceSignalRef) !== refIdentity(expectedSourceRef) ||
      source.markerDigest !== input.projection.markerDigest ||
      source.sameDigestOrdinal !== input.projection.sameDigestOrdinal
    ) {
      return { kind: 'analysis_stale', evidenceRefs: [source.sourceSignalRef.ownerStateRef] };
    }
    const joinRef = sourceJoinRef(input.projection.sourceMessageId, source.markerIndex);
    const matches = await this.findMatches(joinRef);
    const active = matches.filter((candidate) => !candidate.stale && !candidate.completed && candidate.caseActionRef);
    if (active.length === 1) {
      const only = active[0];
      return {
        kind: 'approval_required',
        caseActionRef: only.caseActionRef as string,
        findingArtifactRef: only.artifactRef,
      };
    }
    if (active.length > 1) {
      return { kind: 'analysis_ambiguous', evidenceRefs: active.map((candidate) => candidate.artifactRef).sort() };
    }
    if (matches.length > 0) {
      return { kind: 'analysis_stale', evidenceRefs: matches.map((candidate) => candidate.artifactRef).sort() };
    }
    return {
      kind: 'analysis_required',
      sourceSignalRef: source.sourceSignalRef,
      resume: { kind: 'bounded_time', recheckAt: defaultPawFeelAnalysisRecheckAt(input.projection.discoveredAt) },
    };
  }

  async resolveFollowUp(input: {
    projection: PawFeelDispositionProjection;
    source?: VerifiedPawFeelSourceIdentityContext;
  }) {
    const source = input.source ?? (await this.options.sourceVerifier.verifyIdentity(input.projection));
    if (refIdentity(source.sourceSignalRef) !== refIdentity(derivePawFeelSourceSignalRef(input.projection))) {
      return {
        resolution: 'open' as const,
        continuation: { kind: 'analysis_stale' as const, evidenceRefs: [source.sourceSignalRef.ownerStateRef] },
      };
    }
    const matches = await this.findMatches(sourceJoinRef(input.projection.sourceMessageId, source.markerIndex));
    return projectPawFeelSourceCaseFollowUp({ projection: input.projection, source, matches });
  }

  private async findMatches(joinRef: string): Promise<PawFeelMatchingSourceFinding[]> {
    if (!this.readScope) return this.resolveMatches(joinRef);
    const existing = this.readScope.matches.get(joinRef);
    if (existing) return existing;
    const pending = this.resolveMatches(joinRef);
    this.readScope.matches.set(joinRef, pending);
    return pending;
  }

  private async artifactIndex(): Promise<ArtifactIndex> {
    const load = async () => {
      const records = await loadPawFeelSourceFindingArtifactSnapshot(this.options.harnessFeedbackRoot);
      const index: ArtifactIndex = new Map();
      for (const record of records) {
        for (const joinRef of new Set(record.finding.sourceSignalRefs)) {
          const matching = index.get(joinRef);
          if (matching) matching.push(record);
          else index.set(joinRef, [record]);
        }
      }
      return index;
    };
    if (!this.readScope) return load();
    this.readScope.artifacts ??= load();
    return this.readScope.artifacts;
  }

  private async resolveMatches(joinRef: string): Promise<PawFeelMatchingSourceFinding[]> {
    const candidates = (await this.artifactIndex()).get(joinRef) ?? [];
    return Promise.all(candidates.map((record) => this.resolveArtifact(record)));
  }

  private readCaseEvents(caseId: string): Promise<EvalLifecycleEvent[]> {
    if (!this.readScope) return this.options.eventLog.read(caseId);
    const existing = this.readScope.caseEvents.get(caseId);
    if (existing) return existing;
    const pending = Promise.resolve().then(() => this.options.eventLog.read(caseId));
    this.readScope.caseEvents.set(caseId, pending);
    return pending;
  }

  private async resolveArtifact(
    record: PawFeelSourceFindingArtifactSnapshotRecord,
  ): Promise<PawFeelMatchingSourceFinding> {
    const { artifactRef, finding, root } = record;
    if (!record.digestVerified || !record.sourceRefsValid) {
      return { artifactRef, stale: true, finding, root };
    }
    const bindingMatches =
      root.domainId === finding.domainId &&
      root.caseId === deriveEvalCaseId(root.domainId, root.findingKey) &&
      finding.findingKey === root.findingKey &&
      finding.analysisDisposition === root.findingBinding.analysisDisposition &&
      JSON.stringify(finding.approvalRequirement) === JSON.stringify(root.findingBinding.approvalRequirement) &&
      sameRepairTarget(finding, root);
    const events = await this.readCaseEvents(root.caseId);
    if (!bindingMatches || (finding.analysisDisposition === 'repair' && events.length === 0)) {
      return { artifactRef, stale: true, finding, root };
    }
    const action =
      finding.analysisDisposition === 'repair'
        ? currentAction(events, root.caseId, root.verdictId, artifactRef)
        : { stale: false };
    return {
      artifactRef,
      ...(action.caseActionRef ? { caseActionRef: action.caseActionRef } : {}),
      stale: action.stale,
      ...(action.completed ? { completed: true } : {}),
      finding,
      root,
      events,
    };
  }
}
