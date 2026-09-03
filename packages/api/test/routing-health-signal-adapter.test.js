import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AutomaticRoutingSignalService } = await import(
  '../dist/domains/routing-context/AutomaticRoutingSignalService.js'
);
const { F153HealthRoutingSignalAdapter } = await import(
  '../dist/domains/routing-context/F153HealthRoutingSignalAdapter.js'
);
const { RoutingSignalObservationTelemetry } = await import(
  '../dist/domains/routing-context/RoutingSignalObservationTelemetry.js'
);

const NOW = 20_000;

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

function health(overrides = {}) {
  return {
    v: 1,
    kind: 'provider_health',
    ownerId: 'owner-1',
    observationId: 'health-1',
    observedAt: NOW,
    evidenceRef: 'health-receipt:bounded',
    subjectRef: { type: 'cat', catId: 'sol' },
    authority: 'exact_cat_observation',
    state: 'unavailable',
    validUntil: NOW + 60_000,
    ...overrides,
  };
}

function createHarness(sink = { record: () => undefined }) {
  const store = new MemorySignalStore();
  const automaticSignalService = new AutomaticRoutingSignalService({ signalStore: store });
  const telemetry = new RoutingSignalObservationTelemetry({ sink });
  return {
    store,
    automaticSignalService,
    adapter: new F153HealthRoutingSignalAdapter({ signalStore: store, automaticSignalService, telemetry }),
  };
}

describe('F153HealthRoutingSignalAdapter', () => {
  it('keeps exact-cat evidence narrow and requires authority for provider-wide health', async () => {
    const { adapter, store } = createHarness();
    await adapter.observeHealth(health());
    await adapter.observeHealth(
      health({
        observationId: 'health-provider',
        subjectRef: { type: 'provider', providerId: 'openai' },
        authority: 'canonical_provider_health',
        state: 'degraded',
      }),
    );

    assert.deepEqual(
      store.events.map((event) => event.subjectRef),
      [
        { type: 'cat', catId: 'sol' },
        { type: 'provider', providerId: 'openai' },
      ],
    );
    await assert.rejects(
      adapter.observeHealth(
        health({
          observationId: 'health-promoted',
          subjectRef: { type: 'provider', providerId: 'openai' },
          authority: 'exact_cat_observation',
        }),
      ),
      /provider-wide health requires provider-wide authority/i,
    );
  });

  it('rejects excessive validity and raw high-cardinality health payload fields', async () => {
    const telemetryEvents = [];
    const { adapter } = createHarness({ record: (event) => telemetryEvents.push(event) });
    await assert.rejects(
      adapter.observeHealth(health({ validUntil: NOW + 5 * 60_000 + 1 })),
      /negative health requires future validity bounded to five minutes/i,
    );
    await assert.rejects(
      adapter.observeHealth(health({ error: 'secret raw provider failure', accountId: 'private-account' })),
    );
    assert.deepEqual(telemetryEvents, [
      { source: 'health_probe', subjectKind: 'unknown', transition: 'validate', outcome: 'rejected' },
      { source: 'health_probe', subjectKind: 'unknown', transition: 'validate', outcome: 'rejected' },
    ]);
  });

  it('recovers only older open health assertions for the exact subject and authority family', async () => {
    const { adapter, automaticSignalService, store } = createHarness();
    await adapter.observeHealth(health({ observationId: 'health-exact-old' }));
    await adapter.observeHealth(
      health({
        observationId: 'health-threshold-old',
        authority: 'independent_route_threshold',
        observedAt: NOW + 1,
        validUntil: NOW + 60_001,
      }),
    );
    await automaticSignalService.assert({
      ownerId: 'owner-1',
      observationId: 'dispatch-error-old',
      subjectRef: { type: 'cat', catId: 'sol' },
      state: 'unavailable',
      reasonCode: 'provider_timeout',
      source: 'provider_error',
      observedAt: NOW,
      evidenceRef: 'dispatch-receipt:bounded',
      validUntil: NOW + 60_000,
    });
    await adapter.observeHealth(
      health({
        observationId: 'health-exact-newer-negative',
        observedAt: NOW + 3_000,
        validUntil: NOW + 63_000,
      }),
    );

    await adapter.observeHealth(
      health({
        observationId: 'health-exact-available',
        observedAt: NOW + 2_000,
        state: 'available',
        validUntil: undefined,
      }),
    );

    const recovery = store.events.find((event) => event.eventType === 'recovered');
    const exactOld = store.events.find((event) => event.evidenceRef === 'health-receipt:bounded');
    const threshold = store.events.find((event) => event.reasonCode.includes('independent_route_threshold'));
    const providerError = store.events.find((event) => event.source === 'provider_error');
    const newerNegative = store.events.find(
      (event) => event.eventType === 'asserted' && event.observedAt === NOW + 3_000,
    );
    assert.deepEqual(recovery.closesSignalIds, [exactOld.eventId]);
    assert.equal(recovery.closesSignalIds.includes(threshold.eventId), false);
    assert.equal(recovery.closesSignalIds.includes(providerError.eventId), false);
    assert.equal(recovery.closesSignalIds.includes(newerNegative.eventId), false);
  });

  it('keeps telemetry advisory and reports bounded append/replay outcomes', async () => {
    const events = [];
    const { adapter, store } = createHarness({
      record: (event) => {
        events.push(event);
        return Promise.reject(new Error('collector offline'));
      },
    });
    await adapter.observeHealth(health());
    await adapter.observeHealth(health());

    assert.equal(store.events.length, 1);
    assert.deepEqual(events, [
      { source: 'health_probe', subjectKind: 'cat', transition: 'assert', outcome: 'appended' },
      { source: 'health_probe', subjectKind: 'cat', transition: 'assert', outcome: 'replayed' },
    ]);
  });
});
