import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  automaticRoutingSignalAssertionInputSchema,
  automaticRoutingSignalRecoveryInputSchema,
  routingSignalObservationV1Schema,
} = await import('../dist/domains/routing-context/RoutingSignalObservation.js');
const { AutomaticRoutingSignalError, AutomaticRoutingSignalService } = await import(
  '../dist/domains/routing-context/AutomaticRoutingSignalService.js'
);

const NOW = 10_000;

function providerHealth(overrides = {}) {
  return {
    v: 1,
    kind: 'provider_health',
    ownerId: 'owner-1',
    observationId: 'health:openai:1',
    observedAt: NOW,
    evidenceRef: 'health-receipt:openai:1',
    subjectRef: { type: 'provider', providerId: 'openai' },
    authority: 'canonical_provider_health',
    state: 'unavailable',
    validUntil: NOW + 60_000,
    ...overrides,
  };
}

function dispatchTerminal(overrides = {}) {
  return {
    v: 1,
    kind: 'dispatch_terminal',
    ownerId: 'owner-1',
    observationId: 'dispatch:inv-1',
    observedAt: NOW,
    evidenceRef: 'turn-execution:inv-1',
    catId: 'sol',
    status: 'failed',
    failureClass: 'provider_timeout',
    preflightDecision: {
      v: 1,
      ownerId: 'owner-1',
      observedAt: NOW - 10,
      resolverState: 'fresh',
      snapshotRef: 'sha256:routing-snapshot',
      targets: [{ targetCatId: 'sol', disposition: 'allowed', reasons: [], alternatives: [] }],
    },
    ...overrides,
  };
}

class MemorySignalStore {
  constructor(seed = []) {
    this.events = new Map(seed.map((event) => [`${event.ownerId}\0${event.eventId}`, event]));
    this.appended = [];
  }

  async append(event) {
    this.appended.push(event);
    this.events.set(`${event.ownerId}\0${event.eventId}`, event);
    return { outcome: 'appended', event };
  }

  async get(ownerId, eventId) {
    return this.events.get(`${ownerId}\0${eventId}`) ?? null;
  }
}

function assertedEvent(overrides = {}) {
  return {
    v: 1,
    eventId: 'signal:health:1',
    commandId: 'command:health:1',
    ownerId: 'owner-1',
    subjectRef: { type: 'cat', catId: 'sol' },
    reasonCode: 'provider_unreachable',
    source: 'health_probe',
    observedAt: NOW - 1_000,
    evidenceRef: 'health-receipt:sol:1',
    eventType: 'asserted',
    state: 'unavailable',
    validUntil: NOW + 60_000,
    ...overrides,
  };
}

describe('F293 automatic routing observation contracts', () => {
  it('rejects hidden account identity and unproven provider-wide health scope', () => {
    assert.equal(
      routingSignalObservationV1Schema.safeParse({
        v: 1,
        kind: 'quota_snapshot',
        ownerId: 'owner-1',
        observationId: 'quota:openai:1',
        observedAt: NOW,
        evidenceRef: 'quota-receipt:openai:1',
        providerId: 'openai',
        items: [
          {
            poolId: 'codex-main',
            usedPercent: 100,
            percentKind: 'used',
            accountRef: 'private-company-account',
          },
        ],
      }).success,
      false,
    );
    assert.equal(
      routingSignalObservationV1Schema.safeParse(providerHealth({ authority: 'exact_cat_observation' })).success,
      false,
    );
    assert.equal(
      routingSignalObservationV1Schema.safeParse(
        providerHealth({
          subjectRef: { type: 'cat', catId: 'sol' },
          authority: 'exact_cat_observation',
        }),
      ).success,
      true,
    );
  });

  it('requires bounded negative health validity and unambiguous dispatch terminals', () => {
    assert.equal(routingSignalObservationV1Schema.safeParse(providerHealth({ validUntil: undefined })).success, false);
    assert.equal(
      routingSignalObservationV1Schema.safeParse(providerHealth({ validUntil: NOW + 5 * 60_000 + 1 })).success,
      false,
    );
    assert.equal(
      routingSignalObservationV1Schema.safeParse(dispatchTerminal({ failureClass: undefined })).success,
      false,
    );
    assert.equal(
      routingSignalObservationV1Schema.safeParse(dispatchTerminal({ status: 'succeeded', failureClass: undefined }))
        .success,
      true,
    );
    assert.equal(
      routingSignalObservationV1Schema.safeParse(
        dispatchTerminal({ status: 'succeeded', failureClass: 'provider_timeout' }),
      ).success,
      false,
    );
  });

  it('allows only automatic assertion and recovery sources', () => {
    const assertion = {
      ownerId: 'owner-1',
      observationId: 'health:sol:1',
      subjectRef: { type: 'cat', catId: 'sol' },
      state: 'unavailable',
      reasonCode: 'provider_unreachable',
      source: 'health_probe',
      observedAt: NOW,
      evidenceRef: 'health-receipt:sol:1',
      validUntil: NOW + 60_000,
    };
    assert.equal(automaticRoutingSignalAssertionInputSchema.safeParse(assertion).success, true);
    assert.equal(
      automaticRoutingSignalAssertionInputSchema.safeParse({ ...assertion, source: 'manual_cvo' }).success,
      false,
    );
    assert.equal(
      automaticRoutingSignalRecoveryInputSchema.safeParse({
        ownerId: 'owner-1',
        observationId: 'dispatch:inv-1:success',
        subjectRef: { type: 'cat', catId: 'sol' },
        reasonCode: 'dispatch_succeeded',
        source: 'dispatch_success',
        observedAt: NOW,
        evidenceRef: 'turn-execution:inv-1',
        closesSignalIds: ['signal:health:1'],
        recoverableSources: ['provider_error', 'health_probe'],
      }).success,
      true,
    );
  });
});

describe('AutomaticRoutingSignalService', () => {
  it('derives stable event and command ids from the observation identity', async () => {
    const store = new MemorySignalStore();
    const service = new AutomaticRoutingSignalService({ signalStore: store });
    const input = {
      ownerId: 'owner-1',
      observationId: 'health:sol:1',
      subjectRef: { type: 'cat', catId: 'sol' },
      state: 'unavailable',
      reasonCode: 'provider_unreachable',
      source: 'health_probe',
      observedAt: NOW,
      evidenceRef: 'health-receipt:sol:1',
      validUntil: NOW + 60_000,
    };

    const first = await service.assert(input);
    const replay = await service.assert(input);
    assert.equal(first.event.eventId, replay.event.eventId);
    assert.equal(first.event.commandId, replay.event.commandId);
    assert.match(first.event.eventId, /^routing-signal:[a-f0-9]{32}$/);
    assert.match(first.event.commandId, /^routing-observation:[a-f0-9]{32}$/);
  });

  it('recovers only exact owner, subject and allowed-source assertions', async () => {
    const target = assertedEvent();
    const store = new MemorySignalStore([target]);
    const service = new AutomaticRoutingSignalService({ signalStore: store });
    const recovery = {
      ownerId: 'owner-1',
      observationId: 'dispatch:inv-1:success',
      subjectRef: { type: 'cat', catId: 'sol' },
      reasonCode: 'dispatch_succeeded',
      source: 'dispatch_success',
      observedAt: NOW,
      evidenceRef: 'turn-execution:inv-1',
      closesSignalIds: [target.eventId],
      recoverableSources: ['provider_error', 'health_probe'],
    };

    const result = await service.recover(recovery);
    assert.deepEqual(result.event.closesSignalIds, [target.eventId]);
    assert.equal(result.event.subjectRef.catId, 'sol');

    await assert.rejects(
      () =>
        service.recover({
          ...recovery,
          observationId: 'dispatch:inv-2:success',
          subjectRef: { type: 'cat', catId: 'terra' },
        }),
      (error) => error instanceof AutomaticRoutingSignalError && error.code === 'scope_mismatch',
    );
    await assert.rejects(
      () =>
        service.recover({
          ...recovery,
          observationId: 'dispatch:inv-3:success',
          recoverableSources: ['provider_error'],
        }),
      (error) => error instanceof AutomaticRoutingSignalError && error.code === 'source_mismatch',
    );
  });
});
