import type { RoutingSignalEventV1, RoutingSubjectRefV1 } from './routing-context-inputs.js';

type ClosingSignal = Exclude<RoutingSignalEventV1, { eventType: 'asserted' }>;
type Probe = Extract<ClosingSignal, { eventType: 'recovered' }> & { probeStartedAt: number };

function compare(left: ClosingSignal, right: ClosingSignal): number {
  return left.observedAt - right.observedAt || left.eventId.localeCompare(right.eventId);
}

function catKey(ownerId: string, catId: string): string {
  return JSON.stringify([ownerId, catId]);
}

function sameSubject(left: RoutingSubjectRefV1, right: RoutingSubjectRefV1): boolean {
  if (left.type === 'cat') return right.type === 'cat' && left.catId === right.catId;
  if (left.type === 'provider') return right.type === 'provider' && left.providerId === right.providerId;
  return right.type === 'quota_pool' && left.poolId === right.poolId;
}

/** Pure causal projection; event arrival order and presentation budgets confer no authority. */
export function routingSignalClosures(events: readonly RoutingSignalEventV1[]): Map<string, ClosingSignal> {
  const closures = new Map<string, ClosingSignal>();
  const assertions = new Map(
    events.filter((event) => event.eventType === 'asserted').map((event) => [event.eventId, event]),
  );
  const probesByCat = new Map<string, Probe[]>();
  const closers = events.filter((event): event is ClosingSignal => event.eventType !== 'asserted').sort(compare);
  for (const closer of closers) {
    for (const id of closer.closesSignalIds) {
      const assertion = assertions.get(id);
      if (!assertion) continue;
      if (
        closures.has(assertion.eventId) ||
        assertion.ownerId !== closer.ownerId ||
        !sameSubject(assertion.subjectRef, closer.subjectRef) ||
        assertion.observedAt > closer.observedAt
      )
        continue;
      closures.set(id, closer);
    }
    if (
      closer.eventType === 'recovered' &&
      closer.source === 'dispatch_success' &&
      closer.subjectRef.type === 'cat' &&
      closer.probeStartedAt !== undefined
    ) {
      const key = catKey(closer.ownerId, closer.subjectRef.catId);
      const probes = probesByCat.get(key) ?? [];
      // Only increasing coverage boundaries matter; this keeps lookups logarithmic
      // even when many parallel attempts finish in a different order from their starts.
      if (!probes.length || closer.probeStartedAt > probes[probes.length - 1].probeStartedAt)
        probes.push({ ...closer, probeStartedAt: closer.probeStartedAt });
      probesByCat.set(key, probes);
    }
  }
  for (const assertion of assertions.values()) {
    if (
      assertion.subjectRef.type !== 'cat' ||
      (assertion.source !== 'provider_error' && assertion.source !== 'health_probe')
    )
      continue;
    const probes = probesByCat.get(catKey(assertion.ownerId, assertion.subjectRef.catId)) ?? [];
    let low = 0;
    let high = probes.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (probes[middle].probeStartedAt < assertion.observedAt) low = middle + 1;
      else high = middle;
    }
    const probe = probes[low];
    const existing = closures.get(assertion.eventId);
    if (probe && (!existing || compare(probe, existing) < 0)) closures.set(assertion.eventId, probe);
  }
  return closures;
}
