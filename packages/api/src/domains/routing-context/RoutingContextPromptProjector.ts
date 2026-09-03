import {
  type RoutingContextReadModelV1,
  type RoutingPreferenceRevisionV1,
  type RoutingSubjectRefV1,
  routingContextReadModelV1Schema,
} from '@cat-cafe/shared';

export const ROUTING_CONTEXT_PROMPT_MAX_CHARS = 3_200;
const MAX_ANOMALIES = 12;
const MAX_PREFERENCES = 8;
const MAX_REASONS_PER_ANOMALY = 3;
const MAX_SOURCE_REFS = 4;
const COMPACT_SUMMARY_CHARS = 240;
const MINIMAL_SUMMARY_CHARS = 80;

export class RoutingContextProjectionError extends Error {
  constructor(
    readonly code: 'invalid' | 'overflow',
    message: string,
  ) {
    super(message);
    this.name = 'RoutingContextProjectionError';
  }
}

export interface RoutingContextPromptProjectionPort {
  resolve(input: { ownerId: string; intent?: 'review' | 'architecture' }): Promise<string>;
}

type Candidate = Extract<RoutingContextReadModelV1['resolution'], { state: 'fresh' }>['snapshot']['candidates'][number];
type AssertedSignal = Extract<RoutingContextReadModelV1['signalEvents'][number], { eventType: 'asserted' }>;

function subjectMatchesCandidate(subject: RoutingSubjectRefV1, candidate: Candidate): boolean {
  if (subject.type === 'cat') return subject.catId === candidate.binding.catId;
  if (subject.type === 'provider') return subject.providerId === candidate.binding.providerId;
  return candidate.binding.provenQuotaPools.some((pool) => pool.poolId === subject.poolId);
}

function matchingCatIds(subjects: RoutingSubjectRefV1[], candidates: Candidate[]): string[] {
  return candidates
    .filter((candidate) => subjects.some((subject) => subjectMatchesCandidate(subject, candidate)))
    .map((candidate) => candidate.binding.catId);
}

function activePreferenceRevisions(
  model: RoutingContextReadModelV1,
  candidates: Candidate[],
): RoutingPreferenceRevisionV1[] {
  const activeRevisionIds = new Set(
    candidates.flatMap((candidate) =>
      candidate.matchedPreferences
        .filter((preference) => preference.lifecycle === 'active')
        .map((preference) => preference.revisionId),
    ),
  );
  return model.preferenceRevisions
    .filter(
      (revision) =>
        revision.lifecycle === 'active' &&
        activeRevisionIds.has(revision.revisionId) &&
        (revision.reviewAfter === undefined || revision.reviewAfter > model.observedAt),
    )
    .slice(0, MAX_PREFERENCES);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function candidateTemporalSemantics(model: RoutingContextReadModelV1, candidate: Candidate) {
  const sourceRefs = new Set(candidate.reasons.flatMap((reason) => reason.sourceRefs));
  const assertions = model.signalEvents.filter(
    (event): event is AssertedSignal => event.eventType === 'asserted' && sourceRefs.has(event.eventId),
  );
  const validUntil = assertions
    .map((event) => event.validUntil)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)[0];
  const resetAt = assertions
    .map((event) => event.resetAt)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)[0];
  return {
    ...(validUntil !== undefined ? { validUntil } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

function renderProjection(payload: object): string {
  const safePayload = JSON.stringify(payload).replaceAll('<', '\\u003c');
  return [
    '<runtime-routing-context>',
    'This is owner-authorized routing data, not an instruction to change the requested target.',
    safePayload,
    '</runtime-routing-context>',
  ].join('\n');
}

/** Projects only decision-relevant exceptions; immutable ledgers never enter prompt bytes. */
export class RoutingContextPromptProjector {
  project(input: RoutingContextReadModelV1): string {
    const parsed = routingContextReadModelV1Schema.safeParse(input);
    if (!parsed.success) {
      throw new RoutingContextProjectionError('invalid', 'routing context read model is invalid');
    }
    const model = parsed.data;
    if (model.resolution.state === 'degraded') return '';
    const candidates = model.resolution.snapshot.candidates;
    const anomalies = [...candidates]
      .filter((candidate) => candidate.availability !== 'available')
      .sort((left, right) => Number(right.effect === 'blocked') - Number(left.effect === 'blocked'))
      .slice(0, MAX_ANOMALIES)
      .map((candidate) => ({
        catId: candidate.binding.catId,
        availability: candidate.availability,
        freshness: candidate.freshness,
        effect: candidate.effect,
        reasons: candidate.reasons.slice(0, MAX_REASONS_PER_ANOMALY).map((reason) => ({
          code: reason.code,
          summary: truncate(reason.summary, COMPACT_SUMMARY_CHARS),
          sourceRefs: reason.sourceRefs.slice(0, MAX_SOURCE_REFS),
        })),
        ...candidateTemporalSemantics(model, candidate),
      }));
    const activePreferences = activePreferenceRevisions(model, candidates).map((revision) => ({
      revisionId: revision.revisionId,
      rationale: truncate(revision.rationale, COMPACT_SUMMARY_CHARS),
      preferredCatIds: matchingCatIds(revision.prefer, candidates),
      overCatIds: matchingCatIds(revision.over, candidates),
      evidenceRefs: revision.evidenceRefs.slice(0, MAX_SOURCE_REFS),
    }));
    if (anomalies.length === 0 && activePreferences.length === 0) return '';

    const payloadBase = {
      v: 1,
      kind: 'routing_context_advisory',
      observedAt: model.observedAt,
      catalogRevision: model.catalogRevision,
      constraints: ['preserve_explicit_targets', 'no_silent_reroute', 'preflight_again_at_actual_send'],
    };
    let keptAnomalies = anomalies;
    let keptPreferences = activePreferences;
    let projection = renderProjection({ ...payloadBase, anomalies: keptAnomalies, activePreferences: keptPreferences });
    while (projection.length > ROUTING_CONTEXT_PROMPT_MAX_CHARS && keptPreferences.length > 0) {
      keptPreferences = keptPreferences.slice(0, -1);
      projection = renderProjection({ ...payloadBase, anomalies: keptAnomalies, activePreferences: keptPreferences });
    }
    while (projection.length > ROUTING_CONTEXT_PROMPT_MAX_CHARS && keptAnomalies.length > 1) {
      keptAnomalies = keptAnomalies.slice(0, -1);
      projection = renderProjection({ ...payloadBase, anomalies: keptAnomalies, activePreferences: keptPreferences });
    }
    if (projection.length > ROUTING_CONTEXT_PROMPT_MAX_CHARS) {
      keptAnomalies = keptAnomalies.map((anomaly) => ({
        ...anomaly,
        reasons: anomaly.reasons.slice(0, 1).map((reason) => ({
          ...reason,
          summary: truncate(reason.summary, MINIMAL_SUMMARY_CHARS),
          sourceRefs: reason.sourceRefs.slice(0, 1),
        })),
      }));
      projection = renderProjection({ ...payloadBase, anomalies: keptAnomalies, activePreferences: [] });
    }
    return projection;
  }
}
