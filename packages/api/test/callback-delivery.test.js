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
  it('keeps queued message off live broadcast when A2A enqueue succeeds', async () => {
    const log = logger();
    const result = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      willEnqueueToQueue: true,
      messageId: 'm1',
      threadId: 't1',
      log,
      enqueueA2A: mock.fn(async () => ({ enqueued: ['opus'] })),
      markDelivered: mock.fn(async () => null),
      zeroEnqueuedWarnMessage: 'zero',
      enqueueFailureMessage: 'fail',
    });

    assert.equal(result.shouldBroadcastNow, false);
    assert.deepEqual(result.enqueued, ['opus']);
    assert.equal(result.enqueueAttempted, true);
    assert.equal(result.enqueueFailed, false);
    assert.equal(log.warn.mock.calls.length, 0);
    assert.equal(log.error.mock.calls.length, 0);
  });

  it('fails open to broadcast when a queued message enqueues zero targets', async () => {
    const log = logger();
    const markDelivered = mock.fn(async () => null);
    const result = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      willEnqueueToQueue: true,
      messageId: 'm1',
      threadId: 't1',
      log,
      enqueueA2A: mock.fn(async () => ({ enqueued: [] })),
      markDelivered,
      zeroEnqueuedWarnMessage: 'zero',
      enqueueFailureMessage: 'fail',
    });

    assert.equal(result.shouldBroadcastNow, true);
    assert.deepEqual(result.enqueued, []);
    assert.equal(result.enqueueAttempted, true);
    assert.equal(result.enqueueFailed, false);
    assert.equal(markDelivered.mock.calls.length, 1);
    assert.equal(log.error.mock.calls.length, 0);
  });

  it('fails open to broadcast when enqueue throws', async () => {
    const log = logger();
    const markDelivered = mock.fn(async () => null);
    const result = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      willEnqueueToQueue: true,
      messageId: 'm1',
      threadId: 't1',
      log,
      enqueueA2A: mock.fn(async () => {
        throw new Error('boom');
      }),
      markDelivered,
      zeroEnqueuedWarnMessage: 'zero',
      enqueueFailureMessage: 'fail',
    });

    assert.equal(result.shouldBroadcastNow, true);
    assert.deepEqual(result.enqueued, []);
    assert.equal(result.enqueueAttempted, true);
    assert.equal(result.enqueueFailed, true);
    assert.equal(markDelivered.mock.calls.length, 1);
    assert.equal(log.error.mock.calls.length, 1);
  });

  it('still broadcasts non-queued messages after enqueueing A2A targets', async () => {
    const log = logger();
    const enqueueA2A = mock.fn(async () => ({ enqueued: ['opus'] }));
    const result = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      willEnqueueToQueue: false,
      messageId: 'm1',
      threadId: 't1',
      log,
      enqueueA2A,
      zeroEnqueuedWarnMessage: 'zero',
      enqueueFailureMessage: 'fail',
    });

    assert.equal(result.shouldBroadcastNow, true);
    assert.deepEqual(result.enqueued, ['opus']);
    assert.equal(result.enqueueAttempted, true);
    assert.equal(result.enqueueFailed, false);
    assert.equal(enqueueA2A.mock.calls.length, 1);
  });

  // F216 AC-D6: coalesced targets are handled — enqueued=0 + coalesced>0 must NOT
  // trigger the zero-enqueued warn/recovery path. Message stays queued (not recovered).
  it('does NOT warn or recover when enqueued=0 but coalesced>0 (F216 AC-D6)', async () => {
    const log = logger();
    const markDelivered = mock.fn(async () => null);
    const result = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      willEnqueueToQueue: true,
      messageId: 'm1',
      threadId: 't1',
      log,
      enqueueA2A: mock.fn(async () => ({ enqueued: [], coalesced: ['opus'] })),
      markDelivered,
      zeroEnqueuedWarnMessage: 'zero',
      enqueueFailureMessage: 'fail',
    });

    // Coalesced = handled, so message stays queued (not recovered/broadcast).
    assert.equal(result.shouldBroadcastNow, false, 'coalesced = handled, no broadcast fallback');
    assert.deepEqual(result.enqueued, []);
    assert.equal(result.enqueueAttempted, true);
    assert.equal(result.enqueueFailed, false);
    // markDelivered must NOT be called (message still queued, not recovered).
    assert.equal(markDelivered.mock.calls.length, 0, 'no recovery markDelivered for coalesced');
  });
});
