import type {
  RoutingPreferenceRevisionV1,
  RoutingPreferenceSupersedeCommandV1,
  RoutingSignalEventV1,
  RoutingSignalMarkCommandV1,
  RoutingSubjectRefV1,
} from '@cat-cafe/shared';

type AssertedRoutingSignal = Extract<RoutingSignalEventV1, { eventType: 'asserted' }>;

export function routingSubjectKey(subject: RoutingSubjectRefV1): string {
  if (subject.type === 'cat') return `cat:${subject.catId}`;
  if (subject.type === 'provider') return `provider:${subject.providerId}`;
  return `quota_pool:${subject.poolId}`;
}

export function buildSignalMarkCommand(input: {
  commandId: string;
  subjectRef: RoutingSubjectRefV1;
  state: RoutingSignalMarkCommandV1['state'];
  reasonCode: string;
  note?: string;
  observedAt: number;
  durationMs: number;
}): RoutingSignalMarkCommandV1 {
  return {
    v: 1,
    commandId: input.commandId,
    subjectRef: input.subjectRef,
    state: input.state,
    reasonCode: input.reasonCode,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    validUntil: input.observedAt + input.durationMs,
  };
}

export function openRoutingSignalAssertions(events: readonly RoutingSignalEventV1[]): AssertedRoutingSignal[] {
  const closed = new Set(events.flatMap((event) => (event.eventType === 'asserted' ? [] : event.closesSignalIds)));
  return events.filter(
    (event): event is AssertedRoutingSignal => event.eventType === 'asserted' && !closed.has(event.eventId),
  );
}

export function openRoutingSignalsForSubject(
  events: readonly RoutingSignalEventV1[],
  subject: RoutingSubjectRefV1,
): AssertedRoutingSignal[] {
  const key = routingSubjectKey(subject);
  return openRoutingSignalAssertions(events).filter((event) => routingSubjectKey(event.subjectRef) === key);
}

export function preferenceHeads(revisions: readonly RoutingPreferenceRevisionV1[]): RoutingPreferenceRevisionV1[] {
  const heads = new Map<string, RoutingPreferenceRevisionV1>();
  for (const revision of revisions) {
    const current = heads.get(revision.preferenceId);
    if (!current || revision.version > current.version) heads.set(revision.preferenceId, revision);
  }
  return [...heads.values()].sort((left, right) => right.validFrom - left.validFrom);
}

export function buildRenewPreferenceCommand(
  head: RoutingPreferenceRevisionV1,
  commandId: string,
  reviewAfter: number,
): RoutingPreferenceSupersedeCommandV1 {
  return {
    v: 1,
    commandId,
    baseRevisionId: head.revisionId,
    baseVersion: head.version,
    appliesWhen: head.appliesWhen,
    prefer: head.prefer,
    over: head.over,
    rationale: head.rationale,
    evidenceRefs: head.evidenceRefs,
    reviewAfter,
  };
}

export function newRoutingCommandId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomId}`;
}
