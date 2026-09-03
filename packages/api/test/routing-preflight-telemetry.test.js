import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { RoutingPreflightService } = await import('../dist/domains/routing-context/RoutingPreflightService.js');

function input() {
  return {
    ownerId: 'owner-1',
    observedAt: 10_000,
    catalogRevision: 'catalog:v1',
    candidates: [{ v: 1, catId: 'sol', providerId: 'openai', provenQuotaPools: [] }],
    targetCatIds: ['sol'],
  };
}

function fakeClock(initial = 10_000) {
  let current = initial;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

describe('F293 routing preflight operational telemetry', () => {
  it('exposes process-local failure, circuit, half-open, dedupe and restart behavior', async () => {
    const clock = fakeClock();
    const events = [];
    const telemetry = { record: (event) => events.push(event) };
    const service = new RoutingPreflightService({
      resolver: { resolve: async () => Promise.reject(new Error('redis offline')) },
      clock,
      failureThreshold: 1,
      telemetry,
      processInstanceId: 'process-a',
      restartEpoch: 7,
    });

    await service.preflight(input());
    await service.preflight(input());
    clock.advance(30_000);
    await service.preflight(input());

    assert.ok(
      events.some(
        (event) =>
          event.kind === 'instance_started' && event.scope === 'process' && event.processInstanceId === 'process-a',
      ),
    );
    assert.ok(events.some((event) => event.kind === 'attempt' && event.outcome === 'resolver_error'));
    assert.ok(events.some((event) => event.kind === 'attempt' && event.outcome === 'circuit_open'));
    assert.ok(
      events.some((event) => event.kind === 'circuit_transition' && event.from === 'closed' && event.to === 'open'),
    );
    assert.ok(
      events.some((event) => event.kind === 'circuit_transition' && event.from === 'open' && event.to === 'half_open'),
    );
    assert.ok(events.some((event) => event.kind === 'audit' && event.disposition === 'emitted'));
    assert.ok(events.some((event) => event.kind === 'audit' && event.disposition === 'dedupe_suppressed'));
    assert.ok(events.every((event) => event.scope === 'process' && event.restartEpoch === 7));

    const restartedEvents = [];
    const restarted = new RoutingPreflightService({
      resolver: {
        resolve: async () => ({
          status: 'fresh',
          snapshot: {
            v: 1,
            ownerId: 'owner-1',
            observedAt: 10_000,
            catalogRevision: 'catalog:v1',
            candidates: [],
          },
          inputRevisionRef: 'sha256:fresh',
          sourceRefs: { signalEventIds: [], preferenceRevisionIds: [], dossierRevisions: [] },
        }),
      },
      clock,
      telemetry: { record: (event) => restartedEvents.push(event) },
      processInstanceId: 'process-b',
      restartEpoch: 8,
    });
    const fresh = await restarted.preflight(input());
    assert.equal(fresh.resolverState, 'fresh');
    assert.equal(restartedEvents[0].kind, 'instance_started');
    assert.equal(restartedEvents[0].processInstanceId, 'process-b');
    assert.ok(restartedEvents.some((event) => event.kind === 'attempt' && event.outcome === 'fresh'));
  });

  it('observes timeout without letting a broken telemetry sink become a routing gate', async () => {
    const events = [];
    const never = new Promise(() => {});
    const timeoutService = new RoutingPreflightService({
      resolver: { resolve: async () => never },
      readBudgetMs: 2,
      telemetry: { record: (event) => events.push(event) },
    });
    const timeoutDecision = await timeoutService.preflight(input());
    assert.equal(timeoutDecision.resolverState, 'degraded');
    assert.ok(events.some((event) => event.kind === 'attempt' && event.outcome === 'resolver_timeout'));

    const brokenSinkService = new RoutingPreflightService({
      resolver: {
        resolve: async () => ({
          status: 'degraded',
          reason: 'routing_store_unavailable',
          affectedCatIds: ['sol'],
        }),
      },
      telemetry: { record: () => Promise.reject(new Error('collector offline')) },
    });
    const preserved = await brokenSinkService.preflight(input());
    assert.equal(preserved.targets[0].disposition, 'warned');
  });

  it('keeps process identifiers out of bounded metric attributes', async () => {
    const { routingPreflightMetricAttributes } = await import(
      '../dist/domains/routing-context/RoutingPreflightTelemetry.js'
    );
    const attributes = routingPreflightMetricAttributes({
      kind: 'attempt',
      scope: 'process',
      processInstanceId: 'process-secret',
      restartEpoch: 9,
      observedAt: 10_000,
      attemptKind: 'closed',
      outcome: 'resolver_error',
      durationMs: 12,
    });
    assert.deepEqual(attributes, {
      'operation.name': 'routing_context.preflight.attempt',
      status: 'resolver_error',
    });
  });
});
