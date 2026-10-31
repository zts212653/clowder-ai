import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoutingContextPromptProjector } from '../dist/domains/routing-context/RoutingContextPromptProjector.js';
import { reduceRoutingContext } from '../dist/domains/routing-context/routing-context-reducer.js';

const NOW = 10_000;
const WEEK = 7 * 24 * 60 * 60 * 1_000;
const binding = {
  v: 1,
  catId: 'kimi',
  providerId: 'kimi',
  provenQuotaPools: [{ poolId: 'pool-kimi', evidenceRef: 'catalog:pool' }],
};

function assertion(overrides = {}) {
  return {
    v: 1,
    eventId: 'signal:cat',
    commandId: 'command:cat',
    ownerId: 'owner-1',
    subjectRef: { type: 'cat', catId: 'kimi' },
    reasonCode: 'quota_exhausted',
    source: 'manual_cvo',
    observedAt: 1_000,
    evidenceRef: 'message:assertion',
    eventType: 'asserted',
    state: 'unavailable',
    validUntil: 20_000,
    ...overrides,
  };
}

function retraction(signal) {
  return {
    v: 1,
    eventId: 'signal:retraction',
    commandId: 'command:retraction',
    ownerId: 'owner-1',
    subjectRef: signal.subjectRef,
    reasonCode: 'owner_cleared',
    source: 'manual_cvo',
    observedAt: 5_000,
    evidenceRef: 'message:retraction',
    eventType: 'retracted',
    closesSignalIds: [signal.eventId],
  };
}

function model(signalEvents, observedAt = NOW, profileDiagnostics = []) {
  const snapshot = reduceRoutingContext({
    ownerId: 'owner-1',
    observedAt,
    catalogRevision: 'catalog:v1',
    candidates: [binding],
    profiles: [],
    profileDiagnostics,
    signalEvents,
    preferenceRevisions: [],
  });
  return {
    v: 1,
    ownerId: 'owner-1',
    observedAt,
    catalogRevision: 'catalog:v1',
    resolution: {
      state: 'fresh',
      snapshot,
      inputRevisionRef: 'sha256:input',
      sourceRefs: {
        signalEventIds: signalEvents.map((event) => event.eventId),
        preferenceRevisionIds: [],
        dossierRevisions: [],
      },
    },
    signalEvents,
    preferenceRevisions: [],
  };
}

const projector = new RoutingContextPromptProjector();
const payload = (readModel) => JSON.parse(projector.project(readModel).split('\n')[2]);

test('retraction returns to no-signal projection and leaves the immutable presentation ledger intact', () => {
  for (const validUntil of [NOW, NOW + WEEK]) {
    const signal = assertion({ validUntil });
    const events = [signal, retraction(signal)];
    const original = structuredClone(events);
    const readModel = model(events);
    assert.deepEqual(readModel.resolution.snapshot, model([]).resolution.snapshot);
    assert.equal(projector.project(readModel), '');
    assert.deepEqual(readModel.signalEvents, original);
  }
});

test('expired assertions stay unknown for UI/preflight but never become recurring prompt anomalies', () => {
  for (const time of [NOW, NOW + WEEK, NOW + 2 * WEEK]) {
    for (const boundary of [{ validUntil: NOW }, { validUntil: NOW + 3 * WEEK, resetAt: NOW }]) {
      const signal = assertion(boundary);
      const readModel = model([signal], time);
      const candidate = readModel.resolution.snapshot.candidates[0];
      assert.equal(candidate.availability, 'unknown');
      assert.equal(candidate.freshness, 'stale');
      assert.equal(candidate.effect, 'advisory');
      assert.equal(candidate.reasons[0].code, 'routing_signal_expired');
      assert.deepEqual(readModel.signalEvents, [signal]);
      assert.equal(projector.project(readModel), '');
    }
  }
});

test('still-valid negative signals remain in the prompt until the exact expiry boundary', () => {
  for (const state of ['unavailable', 'degraded', 'scarce']) {
    const signal = assertion({ state, validUntil: NOW });
    const anomaly = payload(model([signal], NOW - 1)).anomalies[0];
    assert.equal(anomaly.catId, 'kimi');
    assert.equal(anomaly.availability, state);
    assert.equal(anomaly.validUntil, NOW);
    assert.equal(anomaly.reasons[0].code, `routing_signal_${state}`);
  }
});

test('retracting one assertion cannot hide independent cat, provider or proven-pool evidence', () => {
  const removed = assertion();
  for (const subjectRef of [
    { type: 'cat', catId: 'kimi' },
    { type: 'provider', providerId: 'kimi' },
    { type: 'quota_pool', poolId: 'pool-kimi' },
  ]) {
    const remaining = assertion({
      eventId: 'signal:remaining',
      commandId: 'command:remaining',
      subjectRef,
      state: 'degraded',
    });
    const events = [removed, retraction(removed), remaining];
    const readModel = model(events);
    assert.deepEqual(readModel.resolution.snapshot, model([remaining]).resolution.snapshot);
    assert.equal(payload(readModel).anomalies[0].availability, 'degraded');
    assert.doesNotMatch(projector.project(readModel), /signal:cat|signal:retraction/);
  }
  const expired = assertion({ eventId: 'signal:other-expired', commandId: 'command:other-expired', validUntil: NOW });
  assert.equal(
    model([removed, retraction(removed), expired]).resolution.snapshot.candidates[0].availability,
    'unknown',
  );
});

test('expiry does not silence an independent invalid-profile diagnostic', () => {
  const readModel = model([assertion({ validUntil: NOW })], NOW, [
    {
      catId: 'kimi',
      reason: { code: 'capability_profile_invalid', summary: 'Invalid profile', sourceRefs: ['dossier:invalid'] },
    },
  ]);
  assert.match(projector.project(readModel), /capability_profile_invalid/);
  assert.doesNotMatch(projector.project(readModel), /routing_signal_expired|validUntil/);
});
