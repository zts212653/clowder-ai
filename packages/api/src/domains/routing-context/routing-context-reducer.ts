import {
  type CapabilityProfileRevisionRefV1,
  capabilityProfileRevisionRefV1Schema,
  type RoutingCandidateBindingV1,
  type RoutingContextSnapshotV1,
  type RoutingPreferenceRevisionV1,
  type RoutingReasonV1,
  type RoutingSignalEventV1,
  type RoutingSubjectRefV1,
  routingCandidateBindingV1Schema,
  routingContextSnapshotV1Schema,
  routingPreferenceRevisionV1Schema,
  routingSignalEventV1Schema,
} from '@cat-cafe/shared';

export interface ReduceRoutingContextInput {
  ownerId: string;
  observedAt: number;
  catalogRevision: string;
  intent?: 'review' | 'architecture';
  candidates: readonly RoutingCandidateBindingV1[];
  profiles: readonly CapabilityProfileRevisionRefV1[];
  signalEvents: readonly RoutingSignalEventV1[];
  preferenceRevisions: readonly RoutingPreferenceRevisionV1[];
}

type ParsedSignal = RoutingSignalEventV1;
type AssertedSignal = Extract<ParsedSignal, { eventType: 'asserted' }>;
type ClosingSignal = Exclude<ParsedSignal, AssertedSignal>;
type Availability = RoutingContextSnapshotV1['candidates'][number]['availability'];
type CandidateProjection = RoutingContextSnapshotV1['candidates'][number];
type PreferenceMatch = CandidateProjection['matchedPreferences'][number];

const STATE_PRIORITY: Readonly<Record<AssertedSignal['state'], number>> = {
  unavailable: 0,
  degraded: 1,
  scarce: 2,
};

function compareIdentity(
  left: { observedAt: number; eventId: string },
  right: { observedAt: number; eventId: string },
): number {
  return left.observedAt - right.observedAt || left.eventId.localeCompare(right.eventId);
}

function subjectMatchesCandidate(subject: RoutingSubjectRefV1, candidate: RoutingCandidateBindingV1): boolean {
  if (subject.type === 'cat') return subject.catId === candidate.catId;
  if (subject.type === 'provider') return subject.providerId === candidate.providerId;
  return candidate.provenQuotaPools.some((pool) => pool.poolId === subject.poolId);
}

function selectProfileHeads(
  profiles: readonly CapabilityProfileRevisionRefV1[],
): Map<string, CapabilityProfileRevisionRefV1> {
  const heads = new Map<string, CapabilityProfileRevisionRefV1>();
  for (const profile of profiles) {
    const current = heads.get(profile.catId);
    if (
      current === undefined ||
      profile.updatedAt > current.updatedAt ||
      (profile.updatedAt === current.updatedAt && profile.dossierRevision.localeCompare(current.dossierRevision) > 0)
    ) {
      heads.set(profile.catId, profile);
    }
  }
  return heads;
}

function selectPreferenceHeads(preferences: readonly RoutingPreferenceRevisionV1[]): RoutingPreferenceRevisionV1[] {
  const heads = new Map<string, RoutingPreferenceRevisionV1>();
  for (const preference of preferences) {
    const current = heads.get(preference.preferenceId);
    if (
      current === undefined ||
      preference.version > current.version ||
      (preference.version === current.version && preference.revisionId.localeCompare(current.revisionId) > 0)
    ) {
      heads.set(preference.preferenceId, preference);
    }
  }
  return [...heads.values()].sort((left, right) => left.preferenceId.localeCompare(right.preferenceId));
}

function buildClosureMap(events: readonly ParsedSignal[]): Map<string, ClosingSignal> {
  const closures = new Map<string, ClosingSignal>();
  const closingEvents = events
    .filter((event): event is ClosingSignal => event.eventType !== 'asserted')
    .sort(compareIdentity);
  for (const closer of closingEvents) {
    for (const assertedId of closer.closesSignalIds) {
      if (!closures.has(assertedId)) closures.set(assertedId, closer);
    }
  }
  return closures;
}

function activeSignalReason(signal: AssertedSignal): RoutingReasonV1 {
  return {
    code: `routing_signal_${signal.state}`,
    summary: signal.note ?? signal.reasonCode,
    sourceRefs: [signal.eventId, signal.evidenceRef],
  };
}

function subjectIdentity(subject: RoutingSubjectRefV1): string {
  if (subject.type === 'cat') return `cat:${subject.catId}`;
  if (subject.type === 'provider') return `provider:${subject.providerId}`;
  return `quota_pool:${subject.poolId}`;
}

function coalesceActiveSignalReasons(signals: readonly AssertedSignal[]): RoutingReasonV1[] {
  const reasons: RoutingReasonV1[] = [];
  const automaticReasonIndexes = new Map<string, number>();
  for (const signal of signals) {
    if (signal.source === 'manual_cvo') {
      reasons.push(activeSignalReason(signal));
      continue;
    }
    const key = [subjectIdentity(signal.subjectRef), signal.state, signal.source, signal.reasonCode].join('\0');
    const existingIndex = automaticReasonIndexes.get(key);
    if (existingIndex === undefined) {
      automaticReasonIndexes.set(key, reasons.length);
      reasons.push(activeSignalReason(signal));
      continue;
    }
    const sourceRefs = reasons[existingIndex].sourceRefs;
    for (const sourceRef of [signal.eventId, signal.evidenceRef]) {
      if (sourceRefs.length >= 32) break;
      if (!sourceRefs.includes(sourceRef)) sourceRefs.push(sourceRef);
    }
  }
  return reasons;
}

function inactiveSignalReason(signal: AssertedSignal, closer?: ClosingSignal): RoutingReasonV1 {
  if (closer?.eventType === 'recovered') {
    return {
      code: 'routing_signal_recovered',
      summary: closer.note ?? closer.reasonCode,
      sourceRefs: [closer.eventId, signal.eventId, closer.evidenceRef],
    };
  }
  if (closer?.eventType === 'retracted') {
    return {
      code: 'routing_signal_retracted',
      summary: closer.note ?? closer.reasonCode,
      sourceRefs: [closer.eventId, signal.eventId, closer.evidenceRef],
    };
  }
  return {
    code: 'routing_signal_expired',
    summary: `${signal.reasonCode} expired without recovery evidence`,
    sourceRefs: [signal.eventId, signal.evidenceRef],
  };
}

function profileReasons(profile?: CapabilityProfileRevisionRefV1): RoutingReasonV1[] {
  if (profile === undefined) return [];
  return profile.relevantSignals.map((signal) => ({
    code: `capability_${signal.kind}`,
    summary: signal.summary,
    sourceRefs: [profile.dossierRevision, ...signal.evidenceRefs],
  }));
}

function effectForAvailability(availability: Availability): CandidateProjection['effect'] {
  if (availability === 'unavailable') return 'blocked';
  if (availability === 'available') return 'eligible';
  return 'advisory';
}

function reduceCandidateSignals(input: {
  candidate: RoutingCandidateBindingV1;
  events: readonly ParsedSignal[];
  closures: ReadonlyMap<string, ClosingSignal>;
  observedAt: number;
}): { availability: Availability; freshness: CandidateProjection['freshness']; reasons: RoutingReasonV1[] } {
  const matchingAssertions = input.events
    .filter((event): event is AssertedSignal => event.eventType === 'asserted')
    .filter((event) => subjectMatchesCandidate(event.subjectRef, input.candidate));

  const active: AssertedSignal[] = [];
  const unknown: Array<{ signal: AssertedSignal; closer?: ClosingSignal }> = [];
  const recovered: Array<{ signal: AssertedSignal; closer: ClosingSignal }> = [];
  for (const signal of matchingAssertions) {
    const closer = input.closures.get(signal.eventId);
    if (closer?.eventType === 'recovered') {
      recovered.push({ signal, closer });
      continue;
    }
    if (closer?.eventType === 'retracted') {
      unknown.push({ signal, closer });
      continue;
    }
    const boundary = Math.min(
      signal.validUntil ?? Number.POSITIVE_INFINITY,
      signal.resetAt ?? Number.POSITIVE_INFINITY,
    );
    if (input.observedAt >= boundary) unknown.push({ signal });
    else active.push(signal);
  }

  if (active.length > 0) {
    active.sort(
      (left, right) => STATE_PRIORITY[left.state] - STATE_PRIORITY[right.state] || compareIdentity(left, right),
    );
    return {
      availability: active[0].state,
      freshness: 'fresh',
      reasons: coalesceActiveSignalReasons(active),
    };
  }
  if (unknown.length > 0) {
    unknown.sort((left, right) => compareIdentity(left.closer ?? left.signal, right.closer ?? right.signal));
    return {
      availability: 'unknown',
      freshness: 'stale',
      reasons: unknown.map(({ signal, closer }) => inactiveSignalReason(signal, closer)),
    };
  }
  if (recovered.length > 0) {
    recovered.sort((left, right) => compareIdentity(left.closer, right.closer));
    return {
      availability: 'available',
      freshness: 'fresh',
      reasons: recovered.map(({ signal, closer }) => inactiveSignalReason(signal, closer)),
    };
  }
  return { availability: 'available', freshness: 'fresh', reasons: [] };
}

function preferenceApplies(
  preference: RoutingPreferenceRevisionV1,
  intent: ReduceRoutingContextInput['intent'],
  candidates: readonly CandidateProjection[],
): boolean {
  if (preference.lifecycle === 'retired') return false;
  if (preference.appliesWhen.intent !== undefined && preference.appliesWhen.intent !== intent) return false;
  return (preference.appliesWhen.requireEligible ?? []).every((subject) =>
    candidates.some(
      (candidate) => candidate.effect === 'eligible' && subjectMatchesCandidate(subject, candidate.binding),
    ),
  );
}

function preferenceRank(preference: RoutingPreferenceRevisionV1, candidate: CandidateProjection): number {
  if (preference.prefer.some((subject) => subjectMatchesCandidate(subject, candidate.binding))) return 0;
  if (preference.over.some((subject) => subjectMatchesCandidate(subject, candidate.binding))) return 2;
  return 1;
}

function matchPreference(
  preference: RoutingPreferenceRevisionV1,
  candidate: CandidateProjection,
  observedAt: number,
): PreferenceMatch | undefined {
  if (
    !preference.prefer.some((subject) => subjectMatchesCandidate(subject, candidate.binding)) &&
    !preference.over.some((subject) => subjectMatchesCandidate(subject, candidate.binding))
  ) {
    return undefined;
  }
  return {
    revisionId: preference.revisionId,
    lifecycle:
      preference.lifecycle === 'active' && preference.reviewAfter !== undefined && observedAt >= preference.reviewAfter
        ? 'review_due'
        : 'active',
  };
}

export function reduceRoutingContext(rawInput: ReduceRoutingContextInput): RoutingContextSnapshotV1 {
  const candidates = rawInput.candidates.map((candidate) => routingCandidateBindingV1Schema.parse(candidate));
  const profiles = rawInput.profiles.map((profile) => capabilityProfileRevisionRefV1Schema.parse(profile));
  const signalEvents = rawInput.signalEvents
    .map((event) => routingSignalEventV1Schema.parse(event))
    .filter((event) => event.ownerId === rawInput.ownerId);
  const preferenceHeads = selectPreferenceHeads(
    rawInput.preferenceRevisions
      .map((preference) => routingPreferenceRevisionV1Schema.parse(preference))
      .filter((preference) => preference.ownerId === rawInput.ownerId),
  );
  const profileHeads = selectProfileHeads(profiles);
  const closures = buildClosureMap(signalEvents);

  const projectedCandidates: CandidateProjection[] = candidates
    .map((binding) => {
      const profile = profileHeads.get(binding.catId);
      const signalState = reduceCandidateSignals({
        candidate: binding,
        events: signalEvents,
        closures,
        observedAt: rawInput.observedAt,
      });
      return {
        binding,
        profile:
          profile === undefined ? { state: 'absent' as const } : { state: 'applied' as const, revision: profile },
        availability: signalState.availability,
        freshness: signalState.freshness,
        reasons: [...signalState.reasons, ...profileReasons(profile)],
        matchedPreferences: [],
        effect: effectForAvailability(signalState.availability),
      };
    })
    .sort((left, right) => left.binding.catId.localeCompare(right.binding.catId));

  const applicablePreferences = preferenceHeads.filter((preference) =>
    preferenceApplies(preference, rawInput.intent, projectedCandidates),
  );
  for (const candidate of projectedCandidates) {
    candidate.matchedPreferences = applicablePreferences
      .map((preference) => matchPreference(preference, candidate, rawInput.observedAt))
      .filter((match): match is PreferenceMatch => match !== undefined);
  }
  const orderingPreferences = applicablePreferences.filter(
    (preference) =>
      preference.lifecycle === 'active' &&
      (preference.reviewAfter === undefined || rawInput.observedAt < preference.reviewAfter),
  );
  projectedCandidates.sort((left, right) => {
    for (const preference of orderingPreferences) {
      const rankDelta = preferenceRank(preference, left) - preferenceRank(preference, right);
      if (rankDelta !== 0) return rankDelta;
    }
    return left.binding.catId.localeCompare(right.binding.catId);
  });

  return routingContextSnapshotV1Schema.parse({
    v: 1,
    ownerId: rawInput.ownerId,
    observedAt: rawInput.observedAt,
    catalogRevision: rawInput.catalogRevision,
    candidates: projectedCandidates,
  });
}
