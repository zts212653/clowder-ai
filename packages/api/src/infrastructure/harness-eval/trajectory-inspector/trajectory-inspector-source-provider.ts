import type { SessionRecord } from '@cat-cafe/shared';
import { projectInvocationTrajectories } from '../../../domains/cats/services/session/InvocationTrajectoryProjector.js';
import type { TranscriptEvent, TranscriptReader } from '../../../domains/cats/services/session/TranscriptReader.js';
import type { ISessionChainStore } from '../../../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import { reduceTrajectoryInspectorEpisodes } from './trajectory-inspector-reducer.js';
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
}

interface Candidate {
  invocationId: string;
  eligibleAtMs: number;
  anomalyKind: TrajectoryInspectorEpisode['anomalyKind'];
  eligibility: Set<TrajectoryInspectorEpisode['eligibility'][number]>;
  threadId?: string;
  sessionId?: string;
  model?: string;
  runtime?: string;
  sourceRefs: Set<string>;
}

interface Drill {
  targetInvocationId: string;
  observedAtMs: number;
  threadIdHint?: string;
  sessionIdHint?: string;
  successful: boolean;
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
      transcriptReader: Pick<TranscriptReader, 'hasTranscript' | 'readAllEvents'>;
      canonicalResolver: (input: CanonicalResolverInput) => Promise<CanonicalResolution>;
      externalEvidenceSource: TrajectoryInspectorExternalEvidenceSource;
    },
  ) {}

  async resolve(
    selectorInput: TrajectoryInspectorWindowSelector,
    context: { ownerUserId: string },
  ): Promise<TrajectoryInspectorEpisodeBundle> {
    const selector = trajectoryInspectorWindowSelectorSchema.parse(selectorInput);
    const { sessions, events, missingTranscriptSessions } = await this.readOwnerTranscripts(context.ownerUserId);
    const candidates = await this.collectCandidates(selector, sessions, events);
    const acceptedEvidence = await this.deps.externalEvidenceSource.listAcceptedEvidence(selector);
    const drills = collectDrills(events, selector);
    const fallbackTargets = collectFallbackTargets(events, selector, [...candidates.keys()]);
    const episodes = await Promise.all(
      [...candidates.values()].map((candidate) =>
        this.resolveEpisode(candidate, context.ownerUserId, drills, fallbackTargets, acceptedEvidence),
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

  private async readOwnerTranscripts(ownerUserId: string): Promise<{
    sessions: SessionRecord[];
    events: TranscriptEvent[];
    missingTranscriptSessions: number;
  }> {
    const threads = await this.deps.threadStore.list(ownerUserId);
    const chains = await Promise.all(threads.map((thread) => this.deps.sessionChainStore.getChainByThread(thread.id)));
    const sessions = chains.flat().filter((session) => session.userId === ownerUserId);
    const transcriptRows = await Promise.all(
      sessions.map(async (session) => ({
        session,
        present: await this.deps.transcriptReader.hasTranscript(session.id, session.threadId, session.catId),
        events: await this.deps.transcriptReader.readAllEvents(session.id, session.threadId, session.catId),
      })),
    );
    return {
      sessions,
      events: transcriptRows.flatMap((row) => row.events),
      missingTranscriptSessions: transcriptRows.filter((row) => !row.present).length,
    };
  }

  private async collectCandidates(
    selector: TrajectoryInspectorWindowSelector,
    sessions: SessionRecord[],
    events: TranscriptEvent[],
  ): Promise<Map<string, Candidate>> {
    const candidates = new Map<string, Candidate>();
    for (const session of sessions) {
      const sessionEvents = events.filter((event) => event.sessionId === session.id);
      for (const trajectory of projectInvocationTrajectories(sessionEvents, session)) {
        if (!['error', 'cancelled', 'timeout'].includes(trajectory.status)) continue;
        const eligibleAtMs = trajectory.endedAt ?? trajectory.startedAt;
        if (!insideWindow(eligibleAtMs, selector)) continue;
        const firstEvent = sessionEvents.find((event) => event.invocationId === trajectory.invocationId);
        const fingerprint = eventFingerprint(firstEvent);
        candidates.set(trajectory.invocationId, {
          invocationId: trajectory.invocationId,
          eligibleAtMs,
          anomalyKind: trajectory.status as Candidate['anomalyKind'],
          eligibility: new Set(['terminal_anomaly']),
          threadId: session.threadId,
          sessionId: session.id,
          ...fingerprint,
          sourceRefs: new Set([
            `inv:${trajectory.invocationId}`,
            `thread:${session.threadId}`,
            `session:${session.id}`,
          ]),
        });
      }
    }
    for (const finding of await this.deps.externalEvidenceSource.listFindings(selector)) {
      if (!insideWindow(finding.foundAtMs, selector)) continue;
      const current = candidates.get(finding.invocationId);
      if (current) {
        current.eligibility.add('f192_invocation_finding');
        finding.sourceRefs.forEach((ref) => current.sourceRefs.add(ref));
        continue;
      }
      candidates.set(finding.invocationId, {
        invocationId: finding.invocationId,
        eligibleAtMs: finding.foundAtMs,
        anomalyKind: 'finding',
        eligibility: new Set(['f192_invocation_finding']),
        threadId: finding.threadId,
        sessionId: finding.sessionId,
        sourceRefs: new Set([`inv:${finding.invocationId}`, ...finding.sourceRefs]),
      });
    }
    return candidates;
  }

  private async resolveEpisode(
    candidate: Candidate,
    ownerUserId: string,
    drills: Drill[],
    fallbackTargets: Set<string>,
    acceptedEvidence: AcceptedEvidence[],
  ): Promise<TrajectoryInspectorEpisode> {
    const canonical = await this.deps.canonicalResolver({
      invocationId: candidate.invocationId,
      userId: ownerUserId,
      threadIdHint: candidate.threadId,
      sessionIdHint: candidate.sessionId,
    });
    const matchingDrills = drills.filter(
      (drill) => drill.targetInvocationId === candidate.invocationId && drill.observedAtMs >= candidate.eligibleAtMs,
    );
    const drillChecks = await Promise.all(
      matchingDrills.map((drill) =>
        this.deps.canonicalResolver({
          invocationId: candidate.invocationId,
          userId: ownerUserId,
          threadIdHint: drill.threadIdHint,
          sessionIdHint: drill.sessionIdHint,
        }),
      ),
    );
    const wrongRef = canonical.status !== 200 || drillChecks.some((result) => result.status !== 200);
    const successfulDrill = matchingDrills.some((drill) => drill.successful);
    const accepted = acceptedEvidence
      .filter((evidence) => evidence.invocationId === candidate.invocationId)
      .sort((left, right) => left.acceptedAtMs - right.acceptedAtMs)[0];
    const canAccept = !wrongRef && successfulDrill && accepted && accepted.acceptedAtMs >= candidate.eligibleAtMs;
    const fallback = fallbackTargets.has(candidate.invocationId);
    const evidenceOutcome = wrongRef
      ? 'wrong_ref'
      : canAccept
        ? 'accepted'
        : successfulDrill || fallback
          ? 'unresolved'
          : 'not_taken';
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

function collectDrills(events: TranscriptEvent[], selector: TrajectoryInspectorWindowSelector): Drill[] {
  const successfulIds = new Set(
    events
      .filter((event) => event.event.type === 'tool_result' && event.event.toolResultStatus !== 'error')
      .map((event) => event.event.toolUseId)
      .filter((value): value is string => typeof value === 'string'),
  );
  const seen = new Set<string>();
  return events.flatMap((event) => {
    if (!insideWindow(event.t, selector) || event.event.type !== 'tool_use') return [];
    const toolName = String(event.event.toolName ?? event.event.name ?? '');
    if (!toolName.endsWith('cat_cafe_read_invocation_detail')) return [];
    const input = asRecord(event.event.toolInput ?? event.event.input);
    if (typeof input?.invocationId !== 'string') return [];
    const toolUseId = event.event.toolUseId;
    const stableId = typeof toolUseId === 'string' ? toolUseId : `${event.sessionId}:${event.eventNo}`;
    if (seen.has(stableId)) return [];
    seen.add(stableId);
    return [
      {
        targetInvocationId: input.invocationId,
        observedAtMs: event.t,
        ...(typeof input.threadId === 'string' ? { threadIdHint: input.threadId } : {}),
        ...(typeof input.sessionId === 'string' ? { sessionIdHint: input.sessionId } : {}),
        // A result can be correlated only through toolUseId. Missing IDs stay fail-closed,
        // while the transcript-local fallback still keeps replay deduplication deterministic.
        successful: typeof toolUseId === 'string' && successfulIds.has(toolUseId),
      },
    ];
  });
}

function collectFallbackTargets(
  events: TranscriptEvent[],
  selector: TrajectoryInspectorWindowSelector,
  invocationIds: string[],
): Set<string> {
  const targets = new Set<string>();
  for (const event of events) {
    if (!insideWindow(event.t, selector) || event.event.type !== 'tool_use') continue;
    const input = asRecord(event.event.toolInput ?? event.event.input);
    const command = typeof input?.command === 'string' ? input.command : '';
    if (!/events\.jsonl|\bjsonl\b/i.test(command)) continue;
    invocationIds.filter((invocationId) => command.includes(invocationId)).forEach((id) => targets.add(id));
  }
  return targets;
}

function eventFingerprint(event: TranscriptEvent | undefined): { model?: string; runtime?: string } {
  const metadata = asRecord(event?.event.metadata);
  const model = typeof metadata?.model === 'string' ? metadata.model : undefined;
  const runtime = typeof metadata?.runtime === 'string' ? metadata.runtime : undefined;
  return { ...(model ? { model } : {}), ...(runtime ? { runtime } : {}) };
}

function insideWindow(value: number, selector: TrajectoryInspectorWindowSelector): boolean {
  return value >= selector.windowStartMs && value < selector.windowEndMs;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
