import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationOwnerReaper } from '../dist/domains/cats/services/agents/invocation/InvocationOwnerReaper.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';

function fixture() {
  const store = new InvocationRecordStore();
  const id = store.create({
    threadId: 'home',
    userId: 'owner',
    targetCats: ['codex61-sol'],
    intent: 'execute',
    actionLeaseCarrier: { kind: 'none' },
    idempotencyKey: 'original',
  }).invocationId;
  store.update(id, { status: 'running' });
  const tracker = new InvocationTracker({ maxSlotTtlMs: 1000 });
  const controller = tracker.start('home', 'codex61-sol', 'owner', ['codex61-sol'], id);
  const events = [];
  return {
    id,
    store,
    tracker,
    controller,
    events,
    make: (lifecycle) =>
      new InvocationOwnerReaper({
        invocationTracker: tracker,
        invocationRecordStore: store,
        ownerLeaseTtlMs: 1000,
        healthSlaMs: 1000,
        turnExecutionStore: { listByParent: async () => [] },
        getProviderLifecycle: lifecycle,
        reconcileZombie: async () => assert.fail('live/unknown health must not terminate or resend'),
        releaseExactOwner: () => assert.fail('must retain owner'),
        log: { info: (data) => events.push(data), warn: (data) => events.push(data) },
      }),
  };
}

test('same owner state logs once and SLA silence signals once across reaper replacement without stopping a live provider', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const h = fixture();
  t.mock.timers.tick(2000);
  const lifecycle = () => ({ stage: 'active', lastActivityAt: 1000 });
  const reaper = h.make(lifecycle);
  for (let n = 0; n < 3; n++) assert.equal((await reaper.runOnce()).keptActive, 1);
  await h.make(lifecycle).runOnce();
  assert.equal(h.events.filter((event) => event.event === 'invocation_owner_reaper_kept_active').length, 1);
  assert.equal(h.events.filter((event) => event.event === 'invocation_owner_provider_silence').length, 1);
  assert.equal(h.controller.signal.aborted, false);
  assert.equal(h.store.get(h.id).status, 'running');
});

test('repeated real probe errors leave automatic recovery within five attempts, preserving the running owner', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const h = fixture();
  t.mock.timers.tick(2000);
  let probes = 0;
  const reaper = h.make(() => {
    probes++;
    throw new Error('provider observation unavailable');
  });
  for (let n = 0; n < 9; n++) await reaper.runOnce();
  assert.equal(probes, 5);
  assert.equal(h.store.get(h.id).status, 'running');
  assert.equal(h.controller.signal.aborted, false);
  assert.equal(h.store.getOwnerRecoveryFacts(h.id).disposition, 'needs_attention');
});
