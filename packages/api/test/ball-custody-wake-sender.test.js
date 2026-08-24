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
  it('returns typed admission receipts and reuses the exact persisted wake after invoke failure', async () => {
    const deliveries = [];
    const triggeredContents = [];
    let persistedContent;
    let triggerCalls = 0;
    const sender = new SchedulerBallCustodyWakeSender({
      async deliver(opts) {
        deliveries.push(opts);
        persistedContent ??= opts.content;
        return 'msg-wake-1';
      },
      async readPersistedContent() {
        return persistedContent;
      },
      invokeTrigger: {
        async trigger(_threadId, _catId, _userId, content) {
          triggeredContents.push(content);
          triggerCalls += 1;
          if (triggerCalls === 1) throw new Error('admission unavailable');
          return 'dispatched';
        },
      },
      logger: { warn() {} },
    });

    const first = await sender.send(wakeInput());
    const changedTask = wakeInput();
    changedTask.task.title = 'A title edited after the persisted wake';
    const second = await sender.send(changedTask);

    assert.deepEqual(first, {
      kind: 'not_admitted',
      messageId: 'msg-wake-1',
      reason: 'invoke_failed',
    });
    assert.deepEqual(second, {
      kind: 'admitted',
      messageId: 'msg-wake-1',
      outcome: 'dispatched',
    });
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].idempotencyKey, 'ball-custody-wake:task-1:1000');
    assert.equal(deliveries[1].idempotencyKey, deliveries[0].idempotencyKey);
    assert.deepEqual(triggeredContents, [persistedContent, persistedContent]);
  });

  it('reports queue-full, missing-trigger, and missing persisted truth as typed non-admission', async () => {
    const deliver = async () => 'msg-wake-1';
    const queueFull = new SchedulerBallCustodyWakeSender({
      deliver,
      readPersistedContent: async () => 'persisted wake',
      invokeTrigger: {
        async trigger() {
          return 'full';
        },
      },
    });
    const unavailable = new SchedulerBallCustodyWakeSender({
      deliver,
      readPersistedContent: async () => 'persisted wake',
    });
    const unreadable = new SchedulerBallCustodyWakeSender({
      deliver,
      readPersistedContent: async () => null,
      invokeTrigger: {
        async trigger() {
          return 'dispatched';
        },
      },
    });

    assert.deepEqual(await queueFull.send(wakeInput()), {
      kind: 'not_admitted',
      messageId: 'msg-wake-1',
      reason: 'queue_full',
    });
    assert.deepEqual(await unavailable.send(wakeInput()), {
      kind: 'not_admitted',
      messageId: 'msg-wake-1',
      reason: 'trigger_unavailable',
    });
    assert.deepEqual(await unreadable.send(wakeInput()), {
      kind: 'not_admitted',
      messageId: 'msg-wake-1',
      reason: 'persisted_message_unavailable',
    });
  });
});
