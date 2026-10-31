import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SchedulerBallCustodyWakeSender } from '../dist/domains/ball-custody/BallCustodyWakeSender.js';

function wakeInput() {
  return {
    task: {
      id: 'task-1',
      threadId: 'thread-1',
      title: 'Wait for review',
      why: 'Resume after the exact review outcome',
      ownerCatId: 'codex',
      userId: 'user-1',
    },
    projection: {
      blockedSinceAt: 1_000,
      lastStateChangeAt: 900,
    },
    at: 5_000,
  };
}

describe('SchedulerBallCustodyWakeSender', () => {
  /*
   * RFC §5.2: the wake is one atomic Message + Queue admission. The old shape persisted the wake,
   * read it back to prove exactness, then admitted it — three steps whose only purpose was to patch
   * the window between the first two. With no window there is nothing to read back, and the typed
   * receipt is simply "was this envelope admitted".
   */
  it('returns a typed admission receipt and keeps one idempotency key across retries', async () => {
    const deliveries = [];
    let attempts = 0;
    const sender = new SchedulerBallCustodyWakeSender({
      async deliver(opts) {
        deliveries.push(opts);
        attempts += 1;
        if (attempts === 1) throw new Error('admission unavailable');
        return 'msg-wake-1';
      },
      logger: { warn() {} },
    });

    const first = await sender.send(wakeInput());
    const changedTask = wakeInput();
    changedTask.task.title = 'A title edited after the first attempt';
    const second = await sender.send(changedTask);

    assert.equal(first.kind, 'not_admitted', 'an unadmitted envelope is never reported as a wake');
    assert.equal(first.reason, 'invoke_failed');
    assert.deepEqual(second, { kind: 'admitted', messageId: 'msg-wake-1', outcome: 'enqueued' });
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].idempotencyKey, 'ball-custody-wake:task-1:1000');
    assert.equal(
      deliveries[1].idempotencyKey,
      deliveries[0].idempotencyKey,
      'the retry reuses the same admission identity, so the Queue converges on one wake',
    );
    assert.equal(deliveries[1].targetCatId, deliveries[0].targetCatId, 'and on the same member');
  });

  it('reports a refused admission as typed non-admission', async () => {
    const refused = new SchedulerBallCustodyWakeSender({
      async deliver() {
        throw new Error('queue admission did not happen');
      },
      logger: { warn() {} },
    });

    const receipt = await refused.send(wakeInput());
    assert.equal(receipt.kind, 'not_admitted');
    assert.equal(receipt.reason, 'invoke_failed');
  });
});
