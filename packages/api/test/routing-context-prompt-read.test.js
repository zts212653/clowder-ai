import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ownerId, primaryCatId, secondaryCatId } from './helpers/routing-dossier-composition-fixture.js';

function assertion(overrides = {}) {
  return {
    v: 1,
    eventId: 'signal:open',
    commandId: 'command:open',
    ownerId,
    subjectRef: { type: 'cat', catId: primaryCatId },
    reasonCode: 'manual_limit',
    source: 'manual_cvo',
    observedAt: 1_000,
    evidenceRef: 'message:manual-limit',
    eventType: 'asserted',
    state: 'scarce',
    validUntil: 90_000,
    resetAt: 80_000,
    ...overrides,
  };
}

function preference() {
  return {
    v: 1,
    preferenceId: 'review-order',
    revisionId: 'review-order:v1',
    commandId: 'command:review-order',
    ownerId,
    appliesWhen: { intent: 'review' },
    prefer: [{ type: 'cat', catId: secondaryCatId }],
    over: [{ type: 'cat', catId: primaryCatId }],
    rationale: 'Prefer the configured reviewer.',
    evidenceRefs: ['message:review-order'],
    version: 1,
    validFrom: 1_000,
    lifecycle: 'active',
  };
}

function payload(projection) {
  return projection ? JSON.parse(projection.split('\n')[2]) : { anomalies: [], activePreferences: [] };
}

test('invocation prompt reads decision sources without loading either audit ledger', async (t) => {
  t.mock.method(Date, 'now', () => 20_000);
  const { runtime } = fixture(t, { signals: [assertion()], preferences: [preference()] });
  for (const store of [runtime.signalStore, runtime.preferenceStore]) {
    t.mock.method(store, 'listByOwner', async () => {
      assert.fail('invocation prompt must not read immutable history');
    });
  }

  const advisory = payload(await runtime.promptProjection.resolve({ ownerId, intent: 'review' }));
  assert.equal(advisory.anomalies[0].validUntil, 90_000);
  assert.equal(advisory.anomalies[0].resetAt, 80_000);
  assert.equal(advisory.activePreferences[0].revisionId, 'review-order:v1');
  assert.deepEqual(advisory.constraints, [
    'preserve_explicit_targets',
    'no_silent_reroute',
    'preflight_again_at_actual_send',
  ]);
});

test('an open assertion keeps its temporal guidance beyond the latest 10k history window', async (t) => {
  t.mock.method(Date, 'now', () => 20_000);
  const signals = [assertion()];
  const { runtime } = fixture(t, { signals });
  const before = payload(await runtime.promptProjection.resolve({ ownerId }));
  signals.push(
    ...Array.from({ length: 10_001 }, (_, index) => ({
      v: 1,
      eventId: `success:${index}`,
      commandId: `success-command:${index}`,
      ownerId,
      subjectRef: { type: 'cat', catId: primaryCatId },
      reasonCode: 'dispatch_success_probe',
      source: 'dispatch_success',
      observedAt: 2_000 + index,
      probeStartedAt: 1_500 + index,
      evidenceRef: `turn:success:${index}`,
      eventType: 'recovered',
      state: 'available',
      closesSignalIds: [],
    })),
  );
  const audit = await runtime.readService.read({ ownerId, observedAt: 20_000 });
  assert.equal(audit.signalEvents.length, 10_000);
  assert.ok(audit.signalEvents.every((event) => event.eventType === 'recovered'));
  assert.equal(audit.resolution.snapshot.candidates[0].availability, 'scarce');

  const after = payload(await runtime.promptProjection.resolve({ ownerId }));
  assert.equal(after.anomalies[0].availability, 'scarce');
  assert.deepEqual(after.anomalies, before.anomalies, 'history volume must not erase validUntil/resetAt');
});

test('prompt decision sources agree with audit projection through recovery, retraction and expiry', async (t) => {
  let now = 20_000;
  t.mock.method(Date, 'now', () => now);
  const signals = [assertion({ source: 'provider_error', state: 'unavailable' })];
  const { runtime } = fixture(t, { signals, preferences: [preference()] });
  async function check(expectedAvailability, expectedAnomalies) {
    const audit = await runtime.readService.read({ ownerId, observedAt: now, intent: 'review' });
    const prompt = await runtime.promptProjection.resolve({ ownerId, intent: 'review' });
    assert.equal(prompt, runtime.promptProjector.project(audit));
    assert.equal(audit.resolution.snapshot.candidates[0].binding.catId, secondaryCatId);
    const primary = audit.resolution.snapshot.candidates.find((candidate) => candidate.binding.catId === primaryCatId);
    assert.equal(primary.availability, expectedAvailability);
    assert.equal(payload(prompt).anomalies.length, expectedAnomalies);
    const preflight = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [primaryCatId] });
    assert.equal(preflight.targets[0].targetCatId, primaryCatId);
    return preflight.targets[0].disposition;
  }

  assert.equal(await check('unavailable', 1), 'rejected');
  signals.push({
    v: 1,
    eventId: 'signal:success',
    commandId: 'command:success',
    ownerId,
    subjectRef: { type: 'cat', catId: primaryCatId },
    source: 'dispatch_success',
    reasonCode: 'dispatch_success_probe',
    observedAt: now,
    probeStartedAt: 1_500,
    evidenceRef: 'turn:success',
    eventType: 'recovered',
    state: 'available',
    closesSignalIds: [],
  });
  assert.equal(await check('available', 0), 'allowed');
  signals.push(assertion({ eventId: 'signal:manual', commandId: 'command:manual', observedAt: 21_000 }));
  now = 25_000;
  await check('scarce', 1);
  signals.push({
    v: 1,
    eventId: 'signal:retract',
    commandId: 'command:retract',
    ownerId,
    subjectRef: { type: 'cat', catId: primaryCatId },
    source: 'manual_cvo',
    reasonCode: 'owner_withdrew_limit',
    observedAt: now,
    evidenceRef: 'message:retract',
    eventType: 'retracted',
    closesSignalIds: ['signal:manual'],
  });
  await check('available', 0);
  signals.push(assertion({ eventId: 'signal:expires', commandId: 'command:expires', observedAt: now }));
  now = 80_000;
  assert.equal(await check('unknown', 0), 'warned');
});
