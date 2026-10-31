import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AutomaticRoutingSignalService } = await import(
  '../dist/domains/routing-context/AutomaticRoutingSignalService.js'
);
const { F051QuotaRoutingSignalAdapter, providerQualifiedQuotaPoolId } = await import(
  '../dist/domains/routing-context/F051QuotaRoutingSignalAdapter.js'
);
const { RoutingSignalObservationTelemetry } = await import(
  '../dist/domains/routing-context/RoutingSignalObservationTelemetry.js'
);

const NOW = 10_000;

function subjectKey(subjectRef) {
  if (subjectRef.type === 'cat') return `cat:${subjectRef.catId}`;
  if (subjectRef.type === 'provider') return `provider:${subjectRef.providerId}`;
  return `quota_pool:${subjectRef.poolId}`;
}

class MemorySignalStore {
  constructor() {
    this.events = [];
  }

  async append(event) {
    const replay = this.events.find(
      (candidate) => candidate.ownerId === event.ownerId && candidate.commandId === event.commandId,
    );
    if (replay) return { outcome: 'replayed', event: replay };
    this.events.push(event);
    return { outcome: 'appended', event };
  }

  async get(ownerId, eventId) {
    return this.events.find((event) => event.ownerId === ownerId && event.eventId === eventId) ?? null;
  }

  async listBySubject(ownerId, subjectRef) {
    const expected = subjectKey(subjectRef);
    return this.events.filter((event) => event.ownerId === ownerId && subjectKey(event.subjectRef) === expected);
  }
}

function createHarness(sink) {
  const store = new MemorySignalStore();
  const automaticSignalService = new AutomaticRoutingSignalService({ signalStore: store });
  const telemetry = sink ? new RoutingSignalObservationTelemetry({ sink }) : undefined;
  return {
    store,
    adapter: new F051QuotaRoutingSignalAdapter({ signalStore: store, automaticSignalService, telemetry }),
  };
}

function snapshot(providerId, observationId, items, overrides = {}) {
  return {
    v: 1,
    kind: 'quota_snapshot',
    ownerId: 'owner-1',
    providerId,
    observationId,
    observedAt: NOW,
    evidenceRef: `quota-receipt:${providerId}:${observationId}`,
    items,
    ...overrides,
  };
}

describe('F051QuotaRoutingSignalAdapter', () => {
  it('keeps provider-qualified pools independent and ignores items without stable pool ids', async () => {
    const { adapter, store } = createHarness();
    await adapter.observeSnapshot(
      snapshot('openai', 'quota:openai:1', [
        { poolId: 'main', usedPercent: 100, percentKind: 'used' },
        { poolId: 'review', usedPercent: 95, percentKind: 'used' },
        { usedPercent: 100, percentKind: 'used' },
      ]),
    );
    await adapter.observeSnapshot(
      snapshot('anthropic', 'quota:anthropic:1', [{ poolId: 'main', usedPercent: 10, percentKind: 'remaining' }]),
    );

    const assertions = store.events.filter((event) => event.eventType === 'asserted');
    assert.deepEqual(
      assertions.map((event) => [event.subjectRef.poolId, event.state]),
      [
        [providerQualifiedQuotaPoolId('openai', 'main'), 'unavailable'],
        [providerQualifiedQuotaPoolId('openai', 'review'), 'scarce'],
        [providerQualifiedQuotaPoolId('anthropic', 'main'), 'scarce'],
      ],
    );
    assert.notEqual(providerQualifiedQuotaPoolId('openai', 'main'), providerQualifiedQuotaPoolId('anthropic', 'main'));
    assert.notEqual(providerQualifiedQuotaPoolId('a:b', 'c'), providerQualifiedQuotaPoolId('a', 'b:c'));
  });

  it('uses a future reset boundary and otherwise falls back to five-minute validity', async () => {
    const { adapter, store } = createHarness();
    await adapter.observeSnapshot(
      snapshot('openai', 'quota:openai:reset', [
        { poolId: 'future', usedPercent: 100, resetsAt: NOW + 60_000 },
        { poolId: 'past', usedPercent: 100, resetsAt: NOW - 1 },
      ]),
    );

    const assertions = store.events.filter((event) => event.eventType === 'asserted');
    assert.equal(assertions[0].resetAt, NOW + 60_000);
    assert.equal(assertions[0].validUntil, undefined);
    assert.equal(assertions[1].resetAt, undefined);
    assert.equal(assertions[1].validUntil, NOW + 5 * 60_000);
  });

  it('does not let a healthy window recover a constrained window from the same exact pool', async () => {
    const { adapter, store } = createHarness();
    await adapter.observeSnapshot(
      snapshot('openai', 'quota:openai:mixed-window', [
        { poolId: 'main', usedPercent: 100 },
        { poolId: 'main', usedPercent: 10 },
      ]),
    );

    assert.equal(store.events.filter((event) => event.eventType === 'asserted').length, 1);
    assert.equal(store.events.filter((event) => event.eventType === 'recovered').length, 0);
  });

  it('recovers only open quota assertions for the exact provider-qualified pool', async () => {
    const { adapter, store } = createHarness();
    await adapter.observeSnapshot(snapshot('openai', 'quota:openai:high', [{ poolId: 'main', usedPercent: 100 }]));
    await adapter.observeSnapshot(
      snapshot('anthropic', 'quota:anthropic:high', [{ poolId: 'main', usedPercent: 100 }]),
    );
    const openAiAssertion = store.events.find(
      (event) =>
        event.eventType === 'asserted' && event.subjectRef.poolId === providerQualifiedQuotaPoolId('openai', 'main'),
    );
    const anthropicAssertion = store.events.find(
      (event) =>
        event.eventType === 'asserted' && event.subjectRef.poolId === providerQualifiedQuotaPoolId('anthropic', 'main'),
    );

    await adapter.observeSnapshot(
      snapshot('openai', 'quota:openai:healthy', [{ poolId: 'main', usedPercent: 89 }], {
        observedAt: NOW + 1_000,
      }),
    );

    const recovery = store.events.find((event) => event.eventType === 'recovered');
    assert.deepEqual(recovery.closesSignalIds, [openAiAssertion.eventId]);
    assert.equal(recovery.closesSignalIds.includes(anthropicAssertion.eventId), false);
  });

  it('does not let a stale healthy snapshot close newer quota evidence', async () => {
    const { adapter, store } = createHarness();
    await adapter.observeSnapshot(
      snapshot('openai', 'quota:openai:newer-high', [{ poolId: 'main', usedPercent: 100 }], {
        observedAt: NOW + 2_000,
      }),
    );
    await adapter.observeSnapshot(
      snapshot('openai', 'quota:openai:stale-low', [{ poolId: 'main', usedPercent: 10 }], {
        observedAt: NOW + 1_000,
      }),
    );

    assert.equal(store.events.filter((event) => event.eventType === 'recovered').length, 0);
  });

  it('reports quota outcomes through the shared bounded observation telemetry', async () => {
    const telemetryEvents = [];
    const { adapter } = createHarness({ record: (event) => telemetryEvents.push(event) });
    await adapter.observeSnapshot(snapshot('openai', 'quota:openai:telemetry', [{ poolId: 'main', usedPercent: 100 }]));
    await adapter.observeSnapshot(snapshot('openai', 'quota:openai:telemetry', [{ poolId: 'main', usedPercent: 100 }]));

    assert.deepEqual(telemetryEvents, [
      { source: 'quota_probe', subjectKind: 'quota_pool', transition: 'assert', outcome: 'appended' },
      { source: 'quota_probe', subjectKind: 'quota_pool', transition: 'assert', outcome: 'replayed' },
    ]);
  });
});
