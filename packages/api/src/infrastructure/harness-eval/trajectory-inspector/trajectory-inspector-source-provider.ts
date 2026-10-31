import type { SessionRecord } from '@cat-cafe/shared';
import type { TranscriptEvent, TranscriptReader } from '../../../domains/cats/services/session/TranscriptReader.js';
import type { ISessionChainStore } from '../../../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import { reduceTrajectoryInspectorEpisodes } from './trajectory-inspector-reducer.js';
import {
  assertCandidateBudget,
  mapWithConcurrency,
  mergeTrajectoryCandidate,
  scanOwnerTrajectoryWindow,
  scanTrajectoryCandidateEvidence,
  sessionOverlapsWindow,
  TRAJECTORY_SCAN_CONCURRENCY,
  type TrajectoryCandidate,
  type TrajectoryDrill,
} from './trajectory-inspector-transcript-scanner.js';
import {
  type TrajectoryInspectorEpisode,
  type TrajectoryInspectorEpisodeBundle,
  type TrajectoryInspectorWindowSelector,
  trajectoryInspectorWindowSelectorSchema,
} from './trajectory-inspector-types.js';

export interface FindingEvidence {
  invocationId: string;
  foundAtMs: number;
  threadId?: string;
  sessionId?: string;
  sourceRefs: string[];
}

export interface AcceptedEvidence {
  invocationId: string;
  acceptedAtMs: number;
  reviewerAgreement: 'agreed' | 'disagreed';
  sourceRefs: string[];
}

export interface TrajectoryInspectorBaselineCohort {
  anomalyKinds: TrajectoryInspectorEpisode['anomalyKind'][];
  modelRuntimeFingerprints: string[];
}

export interface TrajectoryInspectorExternalEvidenceSource {
  listFindings(selector: TrajectoryInspectorWindowSelector): Promise<FindingEvidence[]>;
  listAcceptedEvidence(selector: TrajectoryInspectorWindowSelector): Promise<AcceptedEvidence[]>;
  hasComparableBaseline(
    selector: TrajectoryInspectorWindowSelector,
    cohort: TrajectoryInspectorBaselineCohort,
  ): Promise<boolean>;
}

interface CanonicalResolution {
  status: number;
  body: {
    invocationId?: string;
    threadId?: string;
    sessionId?: string;
    code?: string;
  };
}

interface CanonicalResolverInput {
  invocationId: string;
  userId: string;
  threadIdHint?: string;
  sessionIdHint?: string;
  invocationEventsBySession?: ReadonlyMap<string, readonly TranscriptEvent[]>;
}

export interface TrajectoryInspectorSourceProvider {
  resolve(
    selector: TrajectoryInspectorWindowSelector,
    context: { ownerUserId: string },
  ): Promise<TrajectoryInspectorEpisodeBundle>;
}

export class TrajectoryInspectorSourceProviderImpl implements TrajectoryInspectorSourceProvider {
  constructor(
    private readonly deps: {
      threadStore: Pick<IThreadStore, 'list'>;
      sessionChainStore: Pick<ISessionChainStore, 'getChainByThread'>;
      transcriptReader: Pick<TranscriptReader, 'scanEvents'>;
      candidateLocator?: (input: {
        invocationId: string;
        ownerUserId: string;
      }) => Promise<{ threadId: string; catId: string } | undefined>;
      canonicalResolver: (input: CanonicalResolverInput) => Promise<CanonicalResolution>;
      externalEvidenceSource: TrajectoryInspectorExternalEvidenceSource;
    },
  ) {}

  async resolve(
    selectorInput: TrajectoryInspectorWindowSelector,
    context: { ownerUserId: string },
  ): Promise<TrajectoryInspectorEpisodeBundle> {
    const selector = trajectoryInspectorWindowSelectorSchema.parse(selectorInput);
    const { sessions, candidates, drills, fallbackCommands, missingTranscriptSessions } =
      await scanOwnerTrajectoryWindow(this.deps, selector, context.ownerUserId);
    const windowSessions = sessions.filter((session) => sessionOverlapsWindow(session, selector));
    await this.mergeFindingCandidates(selector, candidates);
    assertCandidateBudget(candidates.size);
    const acceptedEvidence = await this.deps.externalEvidenceSource.listAcceptedEvidence(selector);
    const fallbackTargets = collectFallbackTargets(fallbackCommands, [...candidates.keys()]);
    const evidenceSessions = await this.selectEvidenceSessions(
      sessions,
      windowSessions,
      candidates,
      context.ownerUserId,
    );
    const evidenceIndex = await scanTrajectoryCandidateEvidence(
      this.deps.transcriptReader,
      evidenceSessions,
      candidates,
    );
    const episodes = await mapWithConcurrency([...candidates.values()], TRAJECTORY_SCAN_CONCURRENCY, (candidate) =>
      this.resolveEpisode(
        candidate,
        context.ownerUserId,
        drills,
        fallbackTargets,
        acceptedEvidence,
        evidenceIndex.get(candidate.invocationId),
      ),
    );
    const canonicalResolvedEpisodes = episodes.filter((episode) => episode.evidenceOutcome !== 'wrong_ref').length;
    const fingerprints = [
      ...new Set(episodes.map((episode) => `${episode.model ?? 'unknown'}:${episode.runtime ?? 'unknown'}`)),
    ].sort();
    const anomalyKinds = [...new Set(episodes.map((episode) => episode.anomalyKind))].sort();
    const comparableBaseline = await this.deps.externalEvidenceSource.hasComparableBaseline(selector, {
      anomalyKinds,
      modelRuntimeFingerprints: fingerprints,
    });
    const sourceHealth = {
      canonicalResolvedEpisodes,
      canonicalCandidateEpisodes: episodes.length + missingTranscriptSessions,
      missingTranscriptSessions,
      significantModelRuntimeDrift: fingerprints.length > 1,
      modelRuntimeFingerprints: fingerprints,
      comparableBaseline,
    };
    return {
      selector,
      sourceHealth,
      ...reduceTrajectoryInspectorEpisodes({
        episodes,
        sourceHealth: {
          canonicalResolvedEpisodes: sourceHealth.canonicalResolvedEpisodes,
          canonicalCandidateEpisodes: sourceHealth.canonicalCandidateEpisodes,
          significantModelRuntimeDrift: sourceHealth.significantModelRuntimeDrift,
          comparableBaseline: sourceHealth.comparableBaseline,
        },
      }),
    };
  }

  private async selectEvidenceSessions(
    sessions: SessionRecord[],
    windowSessions: SessionRecord[],
    candidates: Map<string, TrajectoryCandidate>,
    ownerUserId: string,
  ): Promise<SessionRecord[]> {
    const locations = await mapWithConcurrency(
      [...candidates.values()],
      TRAJECTORY_SCAN_CONCURRENCY,
      async (candidate) => {
        const needsCanonicalLocation = !candidate.threadId || !candidate.catId;
        const canonical = needsCanonicalLocation
          ? await this.deps.candidateLocator?.({ invocationId: candidate.invocationId, ownerUserId })
          : undefined;
        return {
          sessionId: candidate.sessionId,
          threadId: canonical?.threadId ?? candidate.threadId,
          catId: canonical?.catId ?? candidate.catId,
        };
      },
    );
    const selectedIds = new Set(windowSessions.map((session) => session.id));
    const selectedThreads = new Set<string>();
    const selectedThreadCats = new Set<string>();
    for (const location of locations) {
      if (location.sessionId) selectedIds.add(location.sessionId);
      if (location.threadId && location.catId) selectedThreadCats.add(`${location.threadId}\0${location.catId}`);
      else if (location.threadId) selectedThreads.add(location.threadId);
    }
    return sessions.filter(
      (session) =>
        selectedIds.has(session.id) ||
        selectedThreads.has(session.threadId) ||
        selectedThreadCats.has(`${session.threadId}\0${session.catId}`),
    );
  }

  private async mergeFindingCandidates(
    selector: TrajectoryInspectorWindowSelector,
    candidates: Map<string, TrajectoryCandidate>,
  ): Promise<void> {
    for (const finding of await this.deps.externalEvidenceSource.listFindings(selector)) {
      if (!insideWindow(finding.foundAtMs, selector)) continue;
      const current = candidates.get(finding.invocationId);
      if (current) {
        current.eligibility.add('f192_invocation_finding');
        for (const ref of finding.sourceRefs) current.sourceRefs.add(ref);
        continue;
      }
      mergeTrajectoryCandidate(candidates, {
        invocationId: finding.invocationId,
        eligibleAtMs: finding.foundAtMs,
        anomalyKind: 'finding',
        eligibility: new Set(['f192_invocation_finding']),
        threadId: finding.threadId,
        sessionId: finding.sessionId,
        sourceRefs: new Set([`inv:${finding.invocationId}`, ...finding.sourceRefs]),
      });
    }
  }

  private async resolveEpisode(
    candidate: TrajectoryCandidate,
    ownerUserId: string,
    drills: TrajectoryDrill[],
    fallbackTargets: Set<string>,
    acceptedEvidence: AcceptedEvidence[],
    invocationEventsBySession: ReadonlyMap<string, readonly TranscriptEvent[]> | undefined,
  ): Promise<TrajectoryInspectorEpisode> {
    const canonical = await this.deps.canonicalResolver(
      canonicalInput(candidate, ownerUserId, candidate.threadId, candidate.sessionId, invocationEventsBySession),
    );
    const matchingDrills = drills.filter(
      (drill) => drill.targetInvocationId === candidate.invocationId && drill.observedAtMs >= candidate.eligibleAtMs,
    );
    const drillChecks = await mapWithConcurrency(matchingDrills, TRAJECTORY_SCAN_CONCURRENCY, (drill) =>
      this.deps.canonicalResolver(
        canonicalInput(candidate, ownerUserId, drill.threadIdHint, drill.sessionIdHint, invocationEventsBySession),
      ),
    );
    const wrongRef = canonical.status !== 200 || drillChecks.some((result) => result.status !== 200);
    const successfulDrill = matchingDrills.some((drill) => drill.successful);
    const accepted = acceptedEvidence
      .filter((evidence) => evidence.invocationId === candidate.invocationId)
      .sort((left, right) => left.acceptedAtMs - right.acceptedAtMs)[0];
    const canAccept = !wrongRef && successfulDrill && accepted && accepted.acceptedAtMs >= candidate.eligibleAtMs;
    const fallback = fallbackTargets.has(candidate.invocationId);
    const evidenceOutcome = selectEvidenceOutcome({ wrongRef, canAccept: !!canAccept, successfulDrill, fallback });
    const threadId = canonical.status === 200 ? canonical.body.threadId : candidate.threadId;
    const sessionId = canonical.status === 200 ? canonical.body.sessionId : candidate.sessionId;
    return {
      episodeId: `trajectory:${candidate.invocationId}`,
      invocationId: candidate.invocationId,
      threadId: threadId ?? 'unresolved',
      sessionId: sessionId ?? 'unresolved',
      eligibleAtMs: candidate.eligibleAtMs,
      eligibility: [...candidate.eligibility].sort(),
      anomalyKind: candidate.anomalyKind,
      ...(candidate.model ? { model: candidate.model } : {}),
      ...(candidate.runtime ? { runtime: candidate.runtime } : {}),
      firstAcceptedEvidenceAtMs: canAccept ? accepted.acceptedAtMs : null,
      evidenceOutcome,
      rawOrJsonlFallback: fallback,
      reviewerAgreement: canAccept ? accepted.reviewerAgreement : 'unreviewed',
      sourceRefs: [...candidate.sourceRefs, ...(canAccept ? accepted.sourceRefs : [])].sort(),
    };
  }
}

function collectFallbackTargets(commands: string[], invocationIds: string[]): Set<string> {
  const targets = new Set<string>();
  for (const command of commands) {
    for (const invocationId of invocationIds) {
      if (command.includes(invocationId)) targets.add(invocationId);
    }
  }
  return targets;
}

function canonicalInput(
  candidate: TrajectoryCandidate,
  ownerUserId: string,
  threadIdHint: string | undefined,
  sessionIdHint: string | undefined,
  invocationEventsBySession: ReadonlyMap<string, readonly TranscriptEvent[]> | undefined,
): CanonicalResolverInput {
  return {
    invocationId: candidate.invocationId,
    userId: ownerUserId,
    threadIdHint,
    sessionIdHint,
    ...(invocationEventsBySession ? { invocationEventsBySession } : {}),
  };
}

function selectEvidenceOutcome(input: {
  wrongRef: boolean;
  canAccept: boolean;
  successfulDrill: boolean;
  fallback: boolean;
}): TrajectoryInspectorEpisode['evidenceOutcome'] {
  if (input.wrongRef) return 'wrong_ref';
  if (input.canAccept) return 'accepted';
  return input.successfulDrill || input.fallback ? 'unresolved' : 'not_taken';
}

function insideWindow(value: number, selector: TrajectoryInspectorWindowSelector): boolean {
  return value >= selector.windowStartMs && value < selector.windowEndMs;
}
