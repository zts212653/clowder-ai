import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  advanceRoutingSignalDecisionProjection,
  buildRoutingSignalDecisionProjection,
  routingSignalDecisionClosureMap,
} = await import('../dist/domains/routing-context/preflight/RoutingSignalDecisionProjection.js');

function assertion(eventId, overrides = {}) {
  return {
    v: 1,
    eventId,
    commandId: `command:${eventId}`,
    ownerId: 'owner-1',
    subjectRef: { type: 'cat', catId: 'sol' },
    reasonCode: 'provider_unreachable',
    source: 'provider_error',
    observedAt: 5_000,
    evidenceRef: `evidence:${eventId}`,
    eventType: 'asserted',
    state: 'unavailable',
    validUntil: 50_000,
    ...overrides,
  };
}

function success(index, overrides = {}) {
  return {
    v: 1,
    eventId: `success:${index}`,
    commandId: `command:success:${index}`,
    ownerId: 'owner-1',
    subjectRef: { type: 'cat', catId: 'sol' },
    reasonCode: 'dispatch_success_probe',
    source: 'dispatch_success',
    observedAt: 6_000 + index,
    evidenceRef: `turn:${index}`,
    eventType: 'recovered',
    state: 'available',
    closesSignalIds: [],
    probeStartedAt: 5_500 + index,
    ...overrides,
  };
}

describe('RoutingSignalDecisionProjection', () => {
  it('collapses 10k ambient dispatch successes while retaining the earliest causal closer', () => {
    const failed = assertion('failure:1');
    const probes = Array.from({ length: 10_000 }, (_, index) => success(index));
    const projection = buildRoutingSignalDecisionProjection({
      ownerId: 'owner-1',
      revision: 10_001,
      events: [failed, ...probes],
    });

    assert.equal(projection.assertions.length, 1);
    assert.equal(projection.closures.length, 1);
    assert.equal(routingSignalDecisionClosureMap(projection).get(failed.eventId)?.eventId, 'success:0');
    assert.equal(projection.successFrontiers.length, 1);
    assert.equal(projection.successFrontiers[0].probe.eventId, 'success:9999');
    assert.ok(JSON.stringify(projection).length < 3_000, 'projection size must not grow with success-probe history');
  });

  it('requires a canonical rebuild when a late assertion needs compacted success history', () => {
    const probes = [success(0), success(1)];
    let projection = buildRoutingSignalDecisionProjection({
      ownerId: 'owner-1',
      revision: 2,
      events: probes,
    });
    const late = assertion('failure:late', { observedAt: 5_500 });
    assert.throws(
      () => advanceRoutingSignalDecisionProjection(projection, late, 3),
      /late assertion requires projection rebuild/,
    );
    const rebuilt = buildRoutingSignalDecisionProjection({
      ownerId: 'owner-1',
      revision: 3,
      events: [...probes, late],
    });
    assert.equal(routingSignalDecisionClosureMap(rebuilt).get(late.eventId)?.eventId, 'success:0');

    const newer = assertion('failure:newer', { observedAt: 6_000 });
    projection = advanceRoutingSignalDecisionProjection(projection, newer, 3);
    assert.equal(routingSignalDecisionClosureMap(projection).has(newer.eventId), false);

    const manual = assertion('failure:manual', { source: 'manual_cvo', observedAt: 5_500 });
    projection = advanceRoutingSignalDecisionProjection(projection, manual, 4);
    assert.equal(routingSignalDecisionClosureMap(projection).has(manual.eventId), false);

    const provider = assertion('failure:provider', {
      subjectRef: { type: 'provider', providerId: 'openai' },
      source: 'health_probe',
      observedAt: 5_500,
    });
    projection = advanceRoutingSignalDecisionProjection(projection, provider, 5);
    assert.equal(routingSignalDecisionClosureMap(projection).has(provider.eventId), false);
  });

  it('keeps an earlier success closer visible before a later concurrent frontier', () => {
    const failed = assertion('failure:temporal-frontier', {
      observedAt: 1_000,
      validUntil: 20_000,
    });
    const firstSuccess = success(0, { observedAt: 2_000, probeStartedAt: 1_500 });
    const laterSuccess = success(1, { observedAt: 10_001, probeStartedAt: 9_500 });
    const projection = buildRoutingSignalDecisionProjection({
      ownerId: 'owner-1',
      revision: 3,
      events: [failed, firstSuccess, laterSuccess],
    });

    assert.equal(routingSignalDecisionClosureMap(projection, 5_000).get(failed.eventId)?.eventId, firstSuccess.eventId);
    assert.equal(projection.successFrontiers[0].probe.eventId, laterSuccess.eventId);
  });

  it('lets an earlier explicit retraction override a later-arriving success proof deterministically', () => {
    const failed = assertion('failure:retracted');
    let projection = buildRoutingSignalDecisionProjection({
      ownerId: 'owner-1',
      revision: 2,
      events: [failed, success(5, { observedAt: 11_000, probeStartedAt: 10_000 })],
    });
    const retracted = {
      v: 1,
      eventId: 'retraction:1',
      commandId: 'command:retraction:1',
      ownerId: 'owner-1',
      subjectRef: failed.subjectRef,
      reasonCode: 'owner_removed',
      source: 'manual_cvo',
      observedAt: 5_500,
      evidenceRef: 'owner:retracted',
      eventType: 'retracted',
      closesSignalIds: [failed.eventId],
    };

    projection = advanceRoutingSignalDecisionProjection(projection, retracted, 3);
    assert.equal(routingSignalDecisionClosureMap(projection).get(failed.eventId)?.eventId, retracted.eventId);
  });

  it('keeps full rebuild and revision deltas identical as success frontiers advance around explicit closure', () => {
    const failed = assertion('failure:restart-equivalence');
    const firstSuccess = success(0, { observedAt: 6_000, probeStartedAt: 5_500 });
    const retracted = {
      v: 1,
      eventId: 'retraction:restart-equivalence',
      commandId: 'command:retraction:restart-equivalence',
      ownerId: 'owner-1',
      subjectRef: failed.subjectRef,
      reasonCode: 'owner_removed',
      source: 'manual_cvo',
      observedAt: 6_500,
      evidenceRef: 'owner:restart-equivalence',
      eventType: 'retracted',
      closesSignalIds: [failed.eventId],
    };
    const latestSuccess = success(1, { observedAt: 7_000, probeStartedAt: 6_000 });
    const events = [failed, firstSuccess, retracted, latestSuccess];
    const rebuilt = buildRoutingSignalDecisionProjection({ ownerId: 'owner-1', revision: events.length, events });
    let incremental = buildRoutingSignalDecisionProjection({ ownerId: 'owner-1', revision: 0, events: [] });
    events.forEach((event, index) => {
      incremental = advanceRoutingSignalDecisionProjection(incremental, event, index + 1);
    });

    assert.deepEqual(incremental, rebuilt);
    assert.equal(routingSignalDecisionClosureMap(rebuilt).get(failed.eventId)?.eventId, firstSuccess.eventId);
  });
});
