// @ts-check
/**
 * F117 R4 combo test (sol adjudication): scheduled trigger message must pass the
 * canonical ingress fence end-to-end — real reminder template + real createDeliverFn
 * + real ConnectorInvokeTrigger + real Queue ledger. Nails "source owner == queue
 * owner and enqueue succeeds", which the Phase 4 mock-based tests cannot detect
 * (the R4 reminder merge regression delivered userId 'scheduler' while triggering
 * with triggerUserId, and would have been rejected by the fence in production).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { ConnectorInvokeTrigger } from '../../dist/infrastructure/email/ConnectorInvokeTrigger.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { createDeliverFn } from '../../dist/infrastructure/scheduler/delivery.js';
import { GlobalControlStore } from '../../dist/infrastructure/scheduler/GlobalControlStore.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../dist/infrastructure/scheduler/TaskRunnerV2.js';
import { templateRegistry } from '../../dist/infrastructure/scheduler/templates/registry.js';

function noopLog() {
  const noop = () => {};
  return /** @type {any} */ ({
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  });
}

function socketHarness() {
  return {
    manager: /** @type {any} */ ({
      emitToUser() {},
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    }),
  };
}

describe('scheduled trigger message passes the canonical ingress fence end-to-end', () => {
  let db;
  let ledger;
  let globalControlStore;
  let store;
  let messageStore;
  let queue;
  let runner;
  let drains;
  const ownerUserId = 'user-owner-1';

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    ledger = new RunLedger(db);
    globalControlStore = new GlobalControlStore(db);
    store = new DynamicTaskStore(db);
    messageStore = new MessageStore();
    queue = new InvocationQueue();
    drains = [];
    const sockets = socketHarness();
    const deliver = createDeliverFn({ messageStore, socketManager: sockets.manager });
    const trigger = new ConnectorInvokeTrigger({
      socketManager: sockets.manager,
      invocationQueue: queue,
      queueProcessor: /** @type {any} */ ({
        async requestDrain(threadId) {
          drains.push(threadId);
        },
      }),
      messageStore,
      log: noopLog(),
    });
    runner = new TaskRunnerV2({
      logger: { info: () => {}, error: () => {} },
      ledger,
      globalControlStore,
      deliver,
      invokeTrigger: trigger,
    });
  });

  test('reminder template → createDeliverFn → ConnectorInvokeTrigger enqueues under the trigger owner', async () => {
    store.insert({
      id: 'remind-owner-fence',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: { message: '喝水', triggerUserId: ownerUserId },
      display: { label: '喝水提醒', category: 'system' },
      deliveryThreadId: 'thread-owner-1',
      enabled: true,
      createdBy: 'opus',
      createdAt: new Date().toISOString(),
    });
    runner.hydrateDynamic(store, templateRegistry);

    await runner.triggerNow('remind-owner-fence', { manual: true });

    // The canonical ingress fence accepted it: queue owner === source owner.
    const entries = queue.list('thread-owner-1', ownerUserId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].execution.ownerAuthProvenance, 'strict');

    // The source message was persisted by createDeliverFn with the verified owner.
    const stored = messageStore.getById(entries[0].payload.messageId);
    assert.ok(stored, 'trigger message must be persisted');
    assert.equal(stored.userId, ownerUserId);
    assert.deepEqual(stored.from, { kind: 'system', service: 'scheduler' });
    assert.equal(stored.deliveryStatus, 'queued');
    assert.deepEqual(drains, ['thread-owner-1']);
  });
});
