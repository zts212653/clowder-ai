import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AutomaticRoutingSignalService } = await import(
  '../dist/domains/routing-context/AutomaticRoutingSignalService.js'
);
const { RoutingDispatchSignalAdapter } = await import(
  '../dist/domains/routing-context/RoutingDispatchSignalAdapter.js'
);
const { classifyRoutingDispatchFailure } = await import(
  '../dist/domains/routing-context/RoutingDispatchSignalContract.js'
);
const { RoutingSignalObservationTelemetry } = await import(
  '../dist/domains/routing-context/RoutingSignalObservationTelemetry.js'
);

const NOW = 30_000;

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

function decision(overrides = {}) {
  return {
    v: 1,
    ownerId: 'owner-1',
    observedAt: NOW,
    resolverState: 'fresh',
    snapshotRef: 'routing-snapshot:1',
    targets: [{ targetCatId: 'sol', disposition: 'allowed', reasons: [], alternatives: [] }],
    ...overrides,
  };
}

function terminal(overrides = {}) {
  return {
    ownerId: 'owner-1',
    observationId: 'invocation-1',
    observedAt: NOW + 1_000,
    evidenceRef: 'turn-execution:invocation-1',
    catId: 'sol',
    status: 'succeeded',
    preflightDecision: decision(),
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
    adapter: new RoutingDispatchSignalAdapter({ signalStore: store, automaticSignalService, telemetry }),
  };
}

async function assertSignal(service, overrides) {
  return (
    await service.assert({
      ownerId: 'owner-1',
      observationId: overrides.observationId,
      subjectRef: overrides.subjectRef,
      state: overrides.state ?? 'unavailable',
      reasonCode: overrides.reasonCode ?? 'provider_unreachable',
      source: overrides.source,
      observedAt: overrides.observedAt ?? NOW - 1_000,
      evidenceRef: overrides.evidenceRef ?? `evidence:${overrides.observationId}`,
      validUntil: overrides.validUntil ?? NOW + 60_000,
    })
  ).event;
}

describe('RoutingDispatchSignalAdapter', () => {
  it('classifies only closed-enum durable provider failures', () => {
    assert.equal(classifyRoutingDispatchFailure({ cliReasonCode: 'quota_exceeded' }), 'quota_exhausted');
    assert.equal(classifyRoutingDispatchFailure({ cliReasonCode: 'auth_failed' }), 'authentication_rejected');
    assert.equal(classifyRoutingDispatchFailure({ cliReasonCode: 'network_error' }), 'provider_unreachable');
    assert.equal(classifyRoutingDispatchFailure({ cliReasonCode: 'cli_stall_timeout' }), 'provider_timeout');
    assert.equal(classifyRoutingDispatchFailure({ providerErrorCode: 'runtime_disconnected' }), 'provider_unreachable');
    assert.equal(classifyRoutingDispatchFailure({ providerErrorCode: 'stream_idle_stall' }), 'provider_timeout');
    assert.equal(classifyRoutingDispatchFailure({ terminalReason: 'invocation_timeout' }), 'provider_timeout');
    assert.equal(classifyRoutingDispatchFailure({ providerErrorCode: 'server_overloaded' }), undefined);
    assert.equal(classifyRoutingDispatchFailure({ providerErrorCode: 'context_overflow' }), undefined);
    assert.equal(classifyRoutingDispatchFailure({ providerErrorCode: 'contains quota_exceeded text' }), undefined);
  });

  it('asserts stable failures only against the exact cat with bounded validity', async () => {
    const telemetryEvents = [];
    const { adapter, store } = createHarness({ record: (event) => telemetryEvents.push(event) });
    const input = terminal({ status: 'failed', failureClass: 'provider_timeout' });

    await adapter.observeTerminal(input);
    await adapter.observeTerminal(input);

    assert.equal(store.events.length, 1);
    assert.deepEqual(store.events[0].subjectRef, { type: 'cat', catId: 'sol' });
    assert.equal(store.events[0].source, 'provider_error');
    assert.equal(store.events[0].reasonCode, 'provider_timeout');
    assert.equal(store.events[0].state, 'unavailable');
    assert.equal(store.events[0].validUntil, NOW + 1_000 + 5 * 60_000);
    assert.deepEqual(telemetryEvents, [
      { source: 'provider_error', subjectKind: 'cat', transition: 'assert', outcome: 'appended' },
      { source: 'provider_error', subjectKind: 'cat', transition: 'assert', outcome: 'replayed' },
    ]);
  });

  it('ignores canceled, interrupted, and unclassified failed terminals', async () => {
    const telemetryEvents = [];
    const { adapter, store } = createHarness({
      record: (event) => {
        telemetryEvents.push(event);
        throw new Error('collector offline');
      },
    });

    await adapter.observeTerminal(terminal({ observationId: 'cancel', status: 'canceled' }));
    await adapter.observeTerminal(terminal({ observationId: 'interrupt', status: 'interrupted' }));
    await adapter.observeTerminal(terminal({ observationId: 'generic-failure', status: 'failed' }));

    assert.equal(store.events.length, 0);
    assert.deepEqual(telemetryEvents, [
      { source: 'provider_error', subjectKind: 'cat', transition: 'validate', outcome: 'ignored' },
      { source: 'provider_error', subjectKind: 'cat', transition: 'validate', outcome: 'ignored' },
      { source: 'provider_error', subjectKind: 'cat', transition: 'validate', outcome: 'ignored' },
    ]);
  });

  it('recovers only referenced, older, still-open cat-scoped health/provider assertions for the exact target', async () => {
    const { adapter, automaticSignalService, store } = createHarness();
    const exactProviderError = await assertSignal(automaticSignalService, {
      observationId: 'provider-error-exact',
      subjectRef: { type: 'cat', catId: 'sol' },
      source: 'provider_error',
    });
    const exactHealth = await assertSignal(automaticSignalService, {
      observationId: 'health-exact',
      subjectRef: { type: 'cat', catId: 'sol' },
      source: 'health_probe',
    });
    const providerHealth = await assertSignal(automaticSignalService, {
      observationId: 'health-provider',
      subjectRef: { type: 'provider', providerId: 'openai' },
      state: 'degraded',
      source: 'health_probe',
    });
    const quota = await assertSignal(automaticSignalService, {
      observationId: 'quota',
      subjectRef: { type: 'quota_pool', poolId: 'quota:openai' },
      source: 'quota_probe',
    });
    const otherCat = await assertSignal(automaticSignalService, {
      observationId: 'health-other-cat',
      subjectRef: { type: 'cat', catId: 'terra' },
      source: 'health_probe',
    });
    const unreferenced = await assertSignal(automaticSignalService, {
      observationId: 'health-unreferenced',
      subjectRef: { type: 'cat', catId: 'sol' },
      source: 'health_probe',
    });
    const newer = await assertSignal(automaticSignalService, {
      observationId: 'provider-error-newer',
      subjectRef: { type: 'cat', catId: 'sol' },
      source: 'provider_error',
      observedAt: NOW + 1,
      validUntil: NOW + 60_001,
    });
    const sourceRefs = [
      exactProviderError.eventId,
      exactHealth.eventId,
      providerHealth.eventId,
      quota.eventId,
      otherCat.eventId,
      newer.eventId,
      'bounded-evidence:not-an-event',
    ];

    await adapter.observeTerminal(
      terminal({
        preflightDecision: decision({
          targets: [
            {
              targetCatId: 'sol',
              disposition: 'warned',
              reasons: [{ code: 'routing_signal_degraded', summary: 'bounded', sourceRefs }],
              alternatives: [],
            },
          ],
        }),
      }),
    );

    const recovered = store.events.filter((event) => event.eventType === 'recovered');
    const closed = new Set(recovered.flatMap((event) => event.closesSignalIds));
    assert.deepEqual([...closed].sort(), [exactProviderError.eventId, exactHealth.eventId].sort());
    assert.equal(closed.has(providerHealth.eventId), false);
    assert.equal(closed.has(quota.eventId), false);
    assert.equal(closed.has(otherCat.eventId), false);
    assert.equal(closed.has(unreferenced.eventId), false);
    assert.equal(closed.has(newer.eventId), false);

    const beforeReplay = store.events.length;
    await adapter.observeTerminal(
      terminal({
        preflightDecision: decision({
          targets: [
            {
              targetCatId: 'sol',
              disposition: 'warned',
              reasons: [{ code: 'routing_signal_degraded', summary: 'bounded', sourceRefs }],
              alternatives: [],
            },
          ],
        }),
      }),
    );
    assert.equal(store.events.length, beforeReplay);
  });

  it('rejects owner and exact-target mismatches before writing routing truth', async () => {
    const telemetryEvents = [];
    const { adapter, store } = createHarness({ record: (event) => telemetryEvents.push(event) });

    await assert.rejects(adapter.observeTerminal(terminal({ ownerId: 'other-owner' })), /same owner/i);
    await assert.rejects(adapter.observeTerminal(terminal({ catId: 'terra' })), /exact cat/i);
    assert.equal(store.events.length, 0);
    assert.deepEqual(telemetryEvents, [
      { source: 'provider_error', subjectKind: 'unknown', transition: 'validate', outcome: 'rejected' },
      { source: 'provider_error', subjectKind: 'unknown', transition: 'validate', outcome: 'rejected' },
    ]);
  });
});
