// F257: whether an evaluation wake reached the evaluator is read from the one
// durable, append-only fact the Queue keeps for it — the exact body exposures on
// the wake message's custody. "No longer queued" is not that fact: the queue
// moves queued → processing → queued when a start fails, and a process restart
// forgets every in-memory queue row.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { resolveCycleWakeReceipt, wakeAwaitsQueueAdmission } = await import(
  '../dist/infrastructure/harness-eval/evaluation/CycleEvaluationDelivery.js'
);

function custody(overrides = {}) {
  return {
    version: 1,
    entryId: 'entry-1',
    revision: 1,
    status: 'queued',
    allTargetCats: ['cat-default'],
    pendingTargetCats: ['cat-default'],
    priority: 'normal',
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}
const exposure = (seenAt, invocationId = `inv-${seenAt}`) => ({ targetCatId: 'cat-default', invocationId, seenAt });
const queuedMessage = (queueCustody) => ({ id: 'wake-1', deliveryStatus: 'queued', queueCustody });

describe('F257 cycle wake receipt: read from durable Queue custody', () => {
  test('a wake waiting in the queue is pending', () => {
    assert.deepEqual(resolveCycleWakeReceipt(queuedMessage(custody())), { state: 'pending' });
  });

  test('a reserved wake is still pending: processing is not delivery', () => {
    assert.deepEqual(resolveCycleWakeReceipt(queuedMessage(custody({ status: 'processing' }))), {
      state: 'pending',
    });
  });

  test('a wake rolled back to queued after a failed start is pending, exactly as before the attempt', () => {
    const rolledBack = custody({ status: 'queued', revision: 3, failedByCatIds: [] });
    assert.deepEqual(resolveCycleWakeReceipt(queuedMessage(rolledBack)), { state: 'pending' });
  });

  test('the first exact body exposure is the delivery time', () => {
    const delivered = custody({ status: 'processing', bodyExposures: [exposure(700), exposure(500), exposure(900)] });
    assert.deepEqual(resolveCycleWakeReceipt(queuedMessage(delivered)), { state: 'delivered', deliveredAt: 500 });
  });

  test('delivery is monotonic: later queue states never take an exposure back', () => {
    const exposures = [exposure(500)];
    for (const later of [
      queuedMessage(custody({ status: 'queued', bodyExposures: exposures, failedByCatIds: ['cat-default'] })),
      queuedMessage(custody({ status: 'terminal', pendingTargetCats: [], bodyExposures: exposures })),
      {
        id: 'wake-1',
        deliveryStatus: 'canceled',
        queueCustody: custody({ status: 'terminal', bodyExposures: exposures }),
      },
      {
        id: 'wake-1',
        deliveryStatus: 'delivered',
        queueCustody: custody({ status: 'terminal', bodyExposures: exposures }),
      },
    ]) {
      assert.deepEqual(resolveCycleWakeReceipt(later), { state: 'delivered', deliveredAt: 500 });
    }
  });

  test('a wake that can never be delivered is dead, not pending forever', () => {
    assert.deepEqual(resolveCycleWakeReceipt(null), { state: 'dead' }, 'the message is gone');
    assert.deepEqual(
      resolveCycleWakeReceipt({ id: 'wake-1', deliveryStatus: 'canceled', queueCustody: custody() }),
      { state: 'dead' },
      'canceled before it ran',
    );
    assert.deepEqual(
      resolveCycleWakeReceipt(queuedMessage(custody({ status: 'terminal', pendingTargetCats: [] }))),
      { state: 'dead' },
      'terminal without any exposure',
    );
    assert.deepEqual(
      resolveCycleWakeReceipt(queuedMessage(custody({ pendingTargetCats: [], withdrawnByCatIds: ['cat-default'] }))),
      { state: 'dead' },
      'its only target was withdrawn',
    );
    assert.deepEqual(
      resolveCycleWakeReceipt({ id: 'wake-1' }),
      { state: 'dead' },
      'no Queue custody: nothing durable will ever report this wake',
    );
  });
});

describe('F257 cycle wake admission: an idempotent replay enters the Queue only while its source can still be owned', () => {
  test('a queued source with no custody yet is the first admission', () => {
    assert.equal(wakeAwaitsQueueAdmission({ id: 'wake-1', deliveryStatus: 'queued' }), true);
  });

  test('a queued source whose live custody has not delivered it continues through its exact carrier', () => {
    assert.equal(wakeAwaitsQueueAdmission(queuedMessage(custody())), true);
    assert.equal(wakeAwaitsQueueAdmission(queuedMessage(custody({ status: 'processing' }))), true);
  });

  test('a source that was delivered, canceled, terminal, or never queued gets no new Queue row', () => {
    const delivered = custody({ status: 'terminal', pendingTargetCats: [], bodyExposures: [exposure(500)] });
    for (const [source, why] of [
      [null, 'the message is gone'],
      [{ id: 'wake-1' }, 'a plain message from before wakes were custodied'],
      [{ id: 'wake-1', deliveryStatus: 'delivered', queueCustody: delivered }, 'already delivered'],
      [queuedMessage(delivered), 'terminal custody, whatever the delivery flag still says'],
      [
        queuedMessage(custody({ bodyExposures: [exposure(500)], failedByCatIds: ['cat-default'] })),
        'the Queue owns its retry',
      ],
      [queuedMessage(custody({ status: 'terminal', pendingTargetCats: [] })), 'terminal without exposure'],
      [{ id: 'wake-1', deliveryStatus: 'canceled' }, 'canceled: the store dropped its custody'],
    ]) {
      assert.equal(wakeAwaitsQueueAdmission(source), false, why);
    }
  });
});
