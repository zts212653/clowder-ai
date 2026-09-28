import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createTypedWaitCustodyFixture as harness } from './helpers/typed-wait-custody-fixture.js';
import { createTypedWaitMetricReader } from './helpers/typed-wait-metrics.js';

const telemetry = createTypedWaitMetricReader();
after(() => telemetry.close());

test('Queue rejects an event_wait witness without a registration reference', async () => {
  const h = await harness();
  delete h.outcome.consumption.waitRegistration;
  const before = await telemetry.read();
  await assert.rejects(h.commit, /typed wait/);
  assert.deepEqual(h.store.getById(h.message.id).queueCustody.handledByCatIds, []);
  const after = await telemetry.read();
  assert.equal(after.falseBypass, before.falseBypass + 1);
  assert.equal(after['event_wait.rejected_other_total'], before['event_wait.rejected_other_total'] + 1);
  assert.match(after.text, /routing_event_wait_reason="proof_invalid"/);
  for (const value of [h.message.id, h.task.id, 'child-1', 'user-1', 'thread-wait', 'Command result']) {
    assert.ok(!after.text.includes(value), `metrics must not contain source identity or body: ${value}`);
  }
});

for (const race of ['done', 'matched', 'expired', 'superseded']) {
  test(`Queue revalidates ${race} after the route obtained its witness`, async () => {
    const h = await harness();
    const transition = h.store.transitionQueueCustody.bind(h.store);
    h.store.transitionQueueCustody = (id, input) => {
      const next = structuredClone(h.active);
      if (race === 'expired') next.expiresAt = Date.now() - 1;
      if (race === 'superseded') {
        next.generation = 2;
        next.ownerFence.generation = 2;
      }
      h.taskStore.update(h.task.id, {
        ...(race === 'done' ? { status: 'done' } : {}),
        automationState: race === 'matched' ? { waitOutcome: { generation: 1, reason: 'matched' } } : { await: next },
      });
      return transition(id, input);
    };
    const before = await telemetry.read();
    await assert.rejects(h.commit, /typed wait/);
    assert.deepEqual(h.store.getById(h.message.id).queueCustody.handledByCatIds, []);
    assert.equal(h.store.getById(h.message.id).deliveryStatus, 'queued');
    const after = await telemetry.read();
    assert.equal(after.falseBypass, before.falseBypass + 1);
    assert.equal(after['event_wait.rejected_stale_total'], before['event_wait.rejected_stale_total'] + 1);
  });
}

test('Queue reports a failed authority read once and keeps the source queued', async () => {
  const h = await harness();
  h.taskStore.getWaitRegistration = () => {
    throw new Error('store unavailable');
  };
  const before = await telemetry.read();
  await assert.rejects(h.commit);
  const after = await telemetry.read();
  assert.equal(after.falseBypass, before.falseBypass + 1);
  assert.equal(after['event_wait.rejected_query_failed_total'], before['event_wait.rejected_query_failed_total'] + 1);
  assert.equal(h.store.getById(h.message.id).deliveryStatus, 'queued');
});

test('Queue counts a mismatched event-wait source as one invalid proof', async () => {
  const h = await harness();
  h.outcome.consumption.sourceMessageId = 'foreign-source';
  const before = await telemetry.read();
  await assert.rejects(h.commit);
  const after = await telemetry.read();
  assert.equal(after.falseBypass, before.falseBypass + 1);
  assert.equal(after['event_wait.rejected_other_total'], before['event_wait.rejected_other_total'] + 1);
  assert.equal(h.store.getById(h.message.id).deliveryStatus, 'queued');
});

test('a retried Queue revision conflict is not an authority rejection', async () => {
  const h = await harness();
  const transition = h.store.transitionQueueCustody.bind(h.store);
  let attempts = 0;
  h.store.transitionQueueCustody = (id, input) => {
    if (++attempts === 1) return { kind: 'revision_mismatch', actualRevision: input.expectedRevision + 1 };
    return transition(id, input);
  };
  const before = await telemetry.read();
  await h.commit();
  assert.equal(attempts, 2);
  assert.equal((await telemetry.read()).falseBypass, before.falseBypass);
  assert.deepEqual(h.store.getById(h.message.id).queueCustody.handledByCatIds, ['opus']);
});

test('a valid registration settles once; later expiry does not undo the committed receipt', async () => {
  const h = await harness();
  const before = await telemetry.read();
  await h.commit();
  assert.deepEqual(h.store.getById(h.message.id).queueCustody.handledByCatIds, ['opus']);
  h.taskStore.update(h.task.id, { status: 'done' });
  await h.commit();
  assert.deepEqual(h.store.getById(h.message.id).queueCustody.handledByCatIds, ['opus']);
  assert.equal((await telemetry.read()).falseBypass, before.falseBypass);
});
