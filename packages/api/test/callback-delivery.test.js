import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { MessageDeliveryService } = await import(
  '../dist/domains/cats/services/agents/invocation/MessageDeliveryService.js'
);

function logger() {
  return {
    error: mock.fn(),
    warn: mock.fn(),
  };
}

describe('callback delivery decision helper', () => {
  it('records a successful wake admission for already-public agent speech', async () => {
    const log = logger();
    const result = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      messageId: 'm1',
      threadId: 't1',
      log,
      enqueueA2A: mock.fn(async () => ({ enqueued: ['opus'] })),
      enqueueFailureMessage: 'fail',
    });

    assert.deepEqual(result.enqueued, ['opus']);
    assert.equal(result.enqueueAttempted, true);
    assert.equal(result.enqueueFailed, false);
    assert.equal(log.warn.mock.calls.length, 0);
    assert.equal(log.error.mock.calls.length, 0);
  });

  it('reports zero handled targets as a failed wake admission', async () => {
    const log = logger();
    const result = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      messageId: 'm1',
      threadId: 't1',
      log,
      enqueueA2A: mock.fn(async () => ({ enqueued: [] })),
      enqueueFailureMessage: 'fail',
    });

    assert.deepEqual(result.enqueued, []);
    assert.equal(result.enqueueAttempted, true);
    assert.equal(result.enqueueFailed, true);
    assert.equal(log.error.mock.calls.length, 0);
  });

  it('reports a thrown wake admission without changing publication state', async () => {
    const log = logger();
    const result = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      messageId: 'm1',
      threadId: 't1',
      log,
      enqueueA2A: mock.fn(async () => {
        throw new Error('boom');
      }),
      enqueueFailureMessage: 'fail',
    });

    assert.deepEqual(result.enqueued, []);
    assert.equal(result.enqueueAttempted, true);
    assert.equal(result.enqueueFailed, true);
    assert.equal(log.error.mock.calls.length, 1);
  });

  it('does not attempt wake admission when the callback has no eligible A2A targets', async () => {
    const log = logger();
    const enqueueA2A = mock.fn(async () => ({ enqueued: ['opus'] }));
    const result = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: false,
      messageId: 'm1',
      threadId: 't1',
      log,
      enqueueA2A,
      enqueueFailureMessage: 'fail',
    });

    assert.deepEqual(result.enqueued, []);
    assert.equal(result.enqueueAttempted, false);
    assert.equal(result.enqueueFailed, false);
    assert.equal(enqueueA2A.mock.calls.length, 0);
  });

  it('treats a coalesced target as an admitted wake (F216 AC-D6)', async () => {
    const log = logger();
    const result = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      messageId: 'm1',
      threadId: 't1',
      log,
      enqueueA2A: mock.fn(async () => ({ enqueued: [], coalesced: ['opus'] })),
      enqueueFailureMessage: 'fail',
    });

    assert.deepEqual(result.enqueued, []);
    assert.equal(result.enqueueAttempted, true);
    assert.equal(result.enqueueFailed, false);
  });
});
