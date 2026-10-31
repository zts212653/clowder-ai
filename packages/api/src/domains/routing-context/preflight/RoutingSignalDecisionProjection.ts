import { createHash } from 'node:crypto';
import {
  type RoutingSignalEventV1,
  type RoutingSubjectRefV1,
  routingSignalClosures,
  routingSignalEventV1Schema,
} from '@cat-cafe/shared';

export type RoutingSignalAssertion = Extract<RoutingSignalEventV1, { eventType: 'asserted' }>;
export type RoutingSignalCloser = Exclude<RoutingSignalEventV1, RoutingSignalAssertion>;
type DispatchSuccessProbe = Extract<RoutingSignalCloser, { eventType: 'recovered' }> & {
  source: 'dispatch_success';
  subjectRef: Extract<RoutingSubjectRefV1, { type: 'cat' }>;
  probeStartedAt: number;
};

export interface RoutingSignalDecisionProjectionV1 {
  v: 1;
  ownerId: string;
  revision: number;
  contentHash: string;
  assertions: RoutingSignalAssertion[];
  closures: Array<{ assertionId: string; closer: RoutingSignalCloser }>;
  successFrontiers: Array<{ catId: string; probe: DispatchSuccessProbe }>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`invalid routing signal decision projection ${label}`);
  }
  return value as Record<string, unknown>;
}

function compareIdentity(
  left: { observedAt: number; eventId: string },
  right: { observedAt: number; eventId: string },
): number {
  return left.observedAt - right.observedAt || left.eventId.localeCompare(right.eventId);
}

function sameSubject(left: RoutingSubjectRefV1, right: RoutingSubjectRefV1): boolean {
  if (left.type === 'cat') return right.type === 'cat' && left.catId === right.catId;
  if (left.type === 'provider') return right.type === 'provider' && left.providerId === right.providerId;
  return right.type === 'quota_pool' && left.poolId === right.poolId;
}

function isDispatchSuccessProbe(event: RoutingSignalEventV1): event is DispatchSuccessProbe {
  return (
    event.eventType === 'recovered' &&
    event.source === 'dispatch_success' &&
    event.subjectRef.type === 'cat' &&
    event.probeStartedAt !== undefined
  );
}

function canDispatchSuccessRecover(assertion: RoutingSignalAssertion, probe: DispatchSuccessProbe): boolean {
  return (
    assertion.ownerId === probe.ownerId &&
    assertion.subjectRef.type === 'cat' &&
    assertion.subjectRef.catId === probe.subjectRef.catId &&
    (assertion.source === 'provider_error' || assertion.source === 'health_probe') &&
    assertion.observedAt <= probe.probeStartedAt
  );
}

function considerClosure(
  closures: Map<string, RoutingSignalCloser>,
  assertion: RoutingSignalAssertion,
  closer: RoutingSignalCloser,
): void {
  const valid = isDispatchSuccessProbe(closer)
    ? canDispatchSuccessRecover(assertion, closer)
    : assertion.ownerId === closer.ownerId &&
      sameSubject(assertion.subjectRef, closer.subjectRef) &&
      assertion.observedAt <= closer.observedAt &&
      closer.closesSignalIds.includes(assertion.eventId);
  if (!valid) return;
  const existing = closures.get(assertion.eventId);
  if (existing === undefined || compareIdentity(closer, existing) < 0) {
    closures.set(assertion.eventId, closer);
  }
}

function considerSuccessFrontier(
  successFrontiers: Map<string, DispatchSuccessProbe>,
  probe: DispatchSuccessProbe,
): void {
  const current = successFrontiers.get(probe.subjectRef.catId);
  if (
    current === undefined ||
    probe.probeStartedAt > current.probeStartedAt ||
    (probe.probeStartedAt === current.probeStartedAt && compareIdentity(probe, current) < 0)
  ) {
    successFrontiers.set(probe.subjectRef.catId, probe);
  }
}

function addAssertion(
  assertions: Map<string, RoutingSignalAssertion>,
  successFrontiers: ReadonlyMap<string, DispatchSuccessProbe>,
  assertion: RoutingSignalAssertion,
): void {
  if (assertions.has(assertion.eventId)) throw new TypeError(`duplicate projected assertion: ${assertion.eventId}`);
  const frontier = assertion.subjectRef.type === 'cat' ? successFrontiers.get(assertion.subjectRef.catId) : undefined;
  if (frontier && canDispatchSuccessRecover(assertion, frontier)) {
    throw new TypeError(`late assertion requires projection rebuild: ${assertion.eventId}`);
  }
  assertions.set(assertion.eventId, assertion);
}

function addCloser(
  assertions: ReadonlyMap<string, RoutingSignalAssertion>,
  closures: Map<string, RoutingSignalCloser>,
  successFrontiers: Map<string, DispatchSuccessProbe>,
  closer: RoutingSignalCloser,
): void {
  for (const assertionId of closer.closesSignalIds) {
    const assertion = assertions.get(assertionId);
    if (!assertion) throw new TypeError(`projected closure assertion missing: ${assertionId}`);
    considerClosure(closures, assertion, closer);
  }
  if (!isDispatchSuccessProbe(closer)) return;
  for (const assertion of assertions.values()) considerClosure(closures, assertion, closer);
  considerSuccessFrontier(successFrontiers, closer);
}

function sortedProjection(input: {
  ownerId: string;
  revision: number;
  assertions: Iterable<RoutingSignalAssertion>;
  closures: Iterable<[string, RoutingSignalCloser]>;
  successFrontiers: Iterable<[string, DispatchSuccessProbe]>;
}): RoutingSignalDecisionProjectionV1 {
  const state = {
    v: 1,
    ownerId: input.ownerId,
    revision: input.revision,
    assertions: [...input.assertions].sort(compareIdentity),
    closures: [...input.closures]
      .map(([assertionId, closer]) => ({ assertionId, closer }))
      .sort((left, right) => left.assertionId.localeCompare(right.assertionId)),
    successFrontiers: [...input.successFrontiers]
      .map(([catId, probe]) => ({ catId, probe }))
      .sort((left, right) => left.catId.localeCompare(right.catId)),
  } as const;
  return {
    ...state,
    contentHash: `sha256:${createHash('sha256').update(canonicalJson(state)).digest('hex')}`,
  };
}

export function buildRoutingSignalDecisionProjection(input: {
  ownerId: string;
  revision: number;
  events: readonly RoutingSignalEventV1[];
}): RoutingSignalDecisionProjectionV1 {
  const events = input.events.map((event) => routingSignalEventV1Schema.parse(event));
  if (events.some((event) => event.ownerId !== input.ownerId)) {
    throw new TypeError('routing signal decision projection cannot mix owners');
  }
  const assertions = events.filter((event): event is RoutingSignalAssertion => event.eventType === 'asserted');
  const closures = routingSignalClosures(events);
  const successFrontiers = new Map<string, DispatchSuccessProbe>();
  for (const event of events) if (isDispatchSuccessProbe(event)) considerSuccessFrontier(successFrontiers, event);
  return sortedProjection({
    ownerId: input.ownerId,
    revision: input.revision,
    assertions,
    closures,
    successFrontiers,
  });
}

export function advanceRoutingSignalDecisionProjection(
  current: RoutingSignalDecisionProjectionV1,
  eventInput: RoutingSignalEventV1,
  nextRevision: number,
): RoutingSignalDecisionProjectionV1 {
  if (nextRevision !== current.revision + 1) {
    throw new TypeError(`routing signal projection revision gap: ${current.revision} -> ${nextRevision}`);
  }
  const event = routingSignalEventV1Schema.parse(eventInput);
  if (event.ownerId !== current.ownerId) throw new TypeError('routing signal projection owner mismatch');

  const assertions = new Map(current.assertions.map((assertion) => [assertion.eventId, assertion]));
  const closures = new Map(current.closures.map(({ assertionId, closer }) => [assertionId, closer]));
  const successFrontiers = new Map(current.successFrontiers.map(({ catId, probe }) => [catId, probe]));

  if (event.eventType === 'asserted') addAssertion(assertions, successFrontiers, event);
  else addCloser(assertions, closures, successFrontiers, event);

  return sortedProjection({
    ownerId: current.ownerId,
    revision: nextRevision,
    assertions: assertions.values(),
    closures,
    successFrontiers,
  });
}

export function advanceRoutingSignalDecisionProjectionSequence(
  current: RoutingSignalDecisionProjectionV1,
  events: readonly RoutingSignalEventV1[],
): RoutingSignalDecisionProjectionV1 {
  let projection = current;
  for (const event of events) {
    projection = advanceRoutingSignalDecisionProjection(projection, event, projection.revision + 1);
  }
  return projection;
}

export function routingSignalDecisionClosureMap(
  projection: RoutingSignalDecisionProjectionV1,
  observedAt = Number.POSITIVE_INFINITY,
): ReadonlyMap<string, RoutingSignalCloser> {
  return new Map(
    projection.closures
      .filter(({ closer }) => closer.observedAt <= observedAt)
      .map(({ assertionId, closer }) => [assertionId, closer] as const),
  );
}

export function routingSignalDecisionSourceEventIds(projection: RoutingSignalDecisionProjectionV1): string[] {
  return [
    ...new Set([
      ...projection.assertions.map((assertion) => assertion.eventId),
      ...projection.closures.map(({ closer }) => closer.eventId),
      ...projection.successFrontiers.map(({ probe }) => probe.eventId),
    ]),
  ].sort();
}

export function parseRoutingSignalDecisionProjection(
  value: unknown,
  expectedOwnerId: string,
): RoutingSignalDecisionProjectionV1 {
  const record = objectRecord(value, 'record');
  if (record.v !== 1 || record.ownerId !== expectedOwnerId) {
    throw new TypeError('invalid routing signal decision projection identity');
  }
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 0) {
    throw new TypeError('invalid routing signal decision projection revision');
  }
  if (!Array.isArray(record.assertions) || !Array.isArray(record.closures) || !Array.isArray(record.successFrontiers)) {
    throw new TypeError('invalid routing signal decision projection collections');
  }

  const assertions = record.assertions.map((raw) => {
    const event = routingSignalEventV1Schema.parse(raw);
    if (event.ownerId !== expectedOwnerId || event.eventType !== 'asserted') {
      throw new TypeError('invalid routing signal projected assertion');
    }
    return event;
  });
  const assertionsById = new Map(assertions.map((assertion) => [assertion.eventId, assertion]));
  if (assertionsById.size !== assertions.length) throw new TypeError('duplicate routing signal projected assertion');

  const closures = record.closures.map((raw) => {
    const entry = objectRecord(raw, 'closure');
    if (typeof entry.assertionId !== 'string') {
      throw new TypeError('invalid routing signal projected closure assertion');
    }
    const assertion = assertionsById.get(entry.assertionId);
    if (!assertion) throw new TypeError('invalid routing signal projected closure assertion');
    const closer = routingSignalEventV1Schema.parse(entry.closer);
    if (closer.ownerId !== expectedOwnerId || closer.eventType === 'asserted') {
      throw new TypeError('invalid routing signal projected closer');
    }
    const valid = isDispatchSuccessProbe(closer)
      ? canDispatchSuccessRecover(assertion, closer)
      : sameSubject(assertion.subjectRef, closer.subjectRef) &&
        assertion.observedAt <= closer.observedAt &&
        closer.closesSignalIds.includes(assertion.eventId);
    if (!valid) {
      throw new TypeError('invalid routing signal projected closure relation');
    }
    return { assertionId: entry.assertionId, closer };
  });
  if (new Set(closures.map(({ assertionId }) => assertionId)).size !== closures.length) {
    throw new TypeError('duplicate routing signal projected closure');
  }

  const successFrontiers = record.successFrontiers.map((raw) => {
    const entry = objectRecord(raw, 'success frontier');
    if (typeof entry.catId !== 'string') throw new TypeError('invalid routing signal projected frontier cat');
    const probe = routingSignalEventV1Schema.parse(entry.probe);
    if (!isDispatchSuccessProbe(probe) || probe.ownerId !== expectedOwnerId || probe.subjectRef.catId !== entry.catId) {
      throw new TypeError('invalid routing signal projected success frontier');
    }
    return { catId: entry.catId, probe };
  });
  if (new Set(successFrontiers.map(({ catId }) => catId)).size !== successFrontiers.length) {
    throw new TypeError('duplicate routing signal projected success frontier');
  }

  const projection = sortedProjection({
    ownerId: expectedOwnerId,
    revision: Number(record.revision),
    assertions,
    closures: closures.map(({ assertionId, closer }) => [assertionId, closer] as const),
    successFrontiers: successFrontiers.map(({ catId, probe }) => [catId, probe] as const),
  });
  if (record.contentHash !== projection.contentHash) {
    throw new TypeError('invalid routing signal decision projection content hash');
  }
  return projection;
}
