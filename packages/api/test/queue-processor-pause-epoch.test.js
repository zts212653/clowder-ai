import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const SLOT_KEY = JSON.stringify(['thread-1', 'opus']);

function depsWithQueuedThread() {
  return {
    queue: {
      hasQueuedForThread: mock.fn(() => true),
      hasDispatchableQueuedForThread: mock.fn(() => true),
      listUsersForThread: mock.fn(() => []),
      list: mock.fn(() => []),
    },
    invocationTracker: {
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-stub' })),
      update: mock.fn(async () => {}),
    },
    router: {
      routeExecution: mock.fn(async function* () {}),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      getById: mock.fn(async () => null),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
  };
}

describe('QueueProcessor pause epoch', () => {
  it('manual clear does not reset epoch before a later refail', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deps = depsWithQueuedThread();
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    await processor.onInvocationComplete('thread-1', 'opus', 'failed');
    assert.equal(/** @type {any} */ (processor).pauseEpoch.get(SLOT_KEY), 1);

    processor.clearPause('thread-1', 'opus');
    assert.equal(
      /** @type {any} */ (processor).pauseEpoch.get(SLOT_KEY),
      1,
      'clearPause must not reset epoch or old timers can collide with later pauses',
    );

    await processor.onInvocationComplete('thread-1', 'opus', 'failed');

    assert.equal(/** @type {any} */ (processor).pauseEpoch.get(SLOT_KEY), 2);
    assert.equal(
      /** @type {any} */ (processor).pausedSlots.has(SLOT_KEY),
      true,
      'newer pause should remain active until its own recovery timer',
    );
  });
});
