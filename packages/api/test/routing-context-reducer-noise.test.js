import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { reduceRoutingContext } = await import('../dist/domains/routing-context/routing-context-reducer.js');
const { freshTargetDecision } = await import(
  '../dist/domains/routing-context/preflight/RoutingPreflightDecisionProjector.js'
);
const { routingDispatchPreflightReceipt } = await import(
  '../dist/domains/routing-context/RoutingDispatchPreflightPort.js'
);

function candidate(catId) {
  return {
    v: 1,
    catId,
    providerId: 'openai',
    provenQuotaPools: [],
  };
}

function duplicateAssertion(index) {
  const eventId = `signal:duplicate:${String(index).padStart(2, '0')}`;
  return {
    v: 1,
    eventId,
    commandId: `command:${eventId}`,
    ownerId: 'owner-1',
    subjectRef: { type: 'cat', catId: 'sol' },
    reasonCode: 'provider_unreachable',
    note: 'Provider probe could not reach the exact cat route.',
    source: 'health_probe',
    observedAt: 1_000,
    evidenceRef: `evidence:${eventId}`,
    eventType: 'asserted',
    state: 'unavailable',
    validUntil: 20_000,
  };
}

function recovery(assertions, { eventId = 'signal:recovered', observedAt = 5_000 } = {}) {
  return {
    v: 1,
    eventId,
    commandId: `command:${eventId}`,
    ownerId: 'owner-1',
    subjectRef: { type: 'cat', catId: 'sol' },
    reasonCode: 'probe_succeeded',
    source: 'health_probe',
    observedAt,
    evidenceRef: `evidence:${eventId}`,
    eventType: 'recovered',
    state: 'available',
    closesSignalIds: assertions.map((event) => event.eventId),
  };
}

function reduce(signalEvents) {
  return reduceRoutingContext({
    ownerId: 'owner-1',
    observedAt: 10_000,
    catalogRevision: 'catalog:v1',
    candidates: [candidate('sol')],
    profiles: [],
    signalEvents,
    preferenceRevisions: [],
  });
}

describe('F293 automatic signal projection noise control', () => {
  it('summarizes recovered history before the display cap and carries that same reason into the send receipt', () => {
    // One probe may close many assertions. Count records, not probes or incidents.
    for (const count of [31, 145, 1]) {
      const assertions = Array.from({ length: count }, (_, index) => duplicateAssertion(index));
      const recoveries = [];
      for (let offset = 0; offset < count; offset += 64) {
        recoveries.push(
          recovery(assertions.slice(offset, offset + 64), {
            eventId: `signal:recovered:${offset}`,
            observedAt: 5_000 + offset,
          }),
        );
      }
      const events = [...assertions, ...recoveries];
      const snapshot = reduce(events);
      const [sol] = snapshot.candidates;
      assert.equal(sol.availability, 'available');
      assert.equal(sol.effect, 'eligible');
      assert.equal(sol.reasons.length, 1, 'old recoveries must not flood every handoff');
      assert.match(sol.reasons[0].summary, new RegExp(`\\b${count}\\b`));
      assert.equal(sol.reasons[0].code, 'routing_signal_recovered');
      assert.deepEqual(sol.reasons[0].sourceRefs, [recoveries.at(-1).eventId]);
      assert.deepEqual(reduce([...events].reverse()), snapshot);

      const resolution = { status: 'fresh', snapshot, inputRevisionRef: 'snapshot:recovered' };
      const target = freshTargetDecision({}, resolution, 'sol');
      const receipt = routingDispatchPreflightReceipt(
        {
          v: 1,
          ownerId: 'owner-1',
          observedAt: 10_000,
          resolverState: 'fresh',
          snapshotRef: resolution.inputRevisionRef,
          targets: [target],
        },
        'sol',
      );
      assert.equal(receipt.target.disposition, 'allowed');
      assert.deepEqual(receipt.target.reasons, sol.reasons);
    }
  });

  it('uses the latest recovery reference deterministically when observation timestamps tie', () => {
    const assertions = [duplicateAssertion(0), duplicateAssertion(1)];
    const earlier = recovery([assertions[0]], { eventId: 'signal:recovered:a' });
    const later = recovery([assertions[1]], { eventId: 'signal:recovered:z' });
    const events = [...assertions, later, earlier];
    const snapshot = reduce(events);
    assert.deepEqual(snapshot.candidates[0].reasons[0].sourceRefs, ['signal:recovered:z']);
    assert.deepEqual(reduce([...events].reverse()), snapshot);
  });

  it('coalesces equivalent assertions while preserving bounded source refs', () => {
    const snapshot = reduceRoutingContext({
      ownerId: 'owner-1',
      observedAt: 10_000,
      catalogRevision: 'catalog:v1',
      candidates: [candidate('sol')],
      profiles: [],
      signalEvents: Array.from({ length: 20 }, (_, index) => duplicateAssertion(index)),
      preferenceRevisions: [],
    });

    const [sol] = snapshot.candidates;
    assert.equal(sol.availability, 'unavailable');
    assert.equal(sol.reasons.length, 1);
    assert.equal(sol.reasons[0].sourceRefs.length, 32);
    assert.deepEqual(sol.reasons[0].sourceRefs.slice(0, 4), [
      'signal:duplicate:00',
      'evidence:signal:duplicate:00',
      'signal:duplicate:01',
      'evidence:signal:duplicate:01',
    ]);
  });
});
