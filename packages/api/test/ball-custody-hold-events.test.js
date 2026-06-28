/**
 * F233 PR3 — hold_ball source events.
 *
 * Existing hold_ball scheduling tests are already large; this file only pins
 * ball-custody side effects at the two true source points:
 *  - successful callback commit -> ball.held
 *  - reminder fire -> ball.hold_expired
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F233 PR3: hold_ball ball-custody events', () => {
  test('POST /api/callbacks/hold-ball records ball.held only after scheduler commit', async () => {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const registry = new InvocationRegistry();
    const threadStore = new ThreadStore();
    const insertedTasks = [];
    const events = [];
    const app = Fastify();

    await app.register(callbacksRoutes, {
      registry,
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
      },
      socketManager: {
        broadcastAgentMessage() {},
        getMessages() {
          return [];
        },
      },
      threadStore,
      evidenceStore: {
        async store() {},
        async search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps: {
        registry,
        taskRunner: {
          registerDynamic() {},
          unregister() {
            return true;
          },
        },
        templateRegistry: {
          get(id) {
            return id === 'reminder' ? { createSpec: (taskId, taskParams) => ({ taskId, taskParams }) } : undefined;
          },
        },
        dynamicTaskStore: {
          insert(record) {
            insertedTasks.push(record);
          },
          getAll() {
            return insertedTasks;
          },
          remove() {
            return true;
          },
        },
        messageStore: {
          async append(msg) {
            return { id: 'hold-visible-msg', ...msg };
          },
        },
        socketManager: { broadcastToRoom() {} },
        threadStore,
        ballCustody: {
          async record(event) {
            events.push(event);
          },
        },
      },
    });

    const thread = await threadStore.create('user-f233-held', 'f233-held');
    const { invocationId, callbackToken } = await registry.create('user-f233-held', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { reason: 'waiting on CI', nextStep: 'check status', wakeAfterMs: 60_000 },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'ball.held');
    assert.equal(events[0].sourceEventId, `hold:${thread.id}:codex:${insertedTasks[0].trigger.fireAt}`);
    assert.equal(events[0].subjectKey, `ball:thread:${thread.id}`);
    assert.deepEqual(events[0].payload, { catId: 'codex', fireAt: insertedTasks[0].trigger.fireAt });
  });

  test('hold-ball reminder fire records ball.hold_expired at execution point', async () => {
    const { reminderTemplate } = await import('../dist/infrastructure/scheduler/templates/reminder.js');
    const fireAt = Date.now() - 1;
    const events = [];
    const delivered = [];
    const spec = reminderTemplate.createSpec('hold-ball-abc123', {
      trigger: { type: 'once', fireAt },
      params: {
        message: 'wake now',
        targetCatId: 'codex',
        triggerUserId: 'user-f233-expired',
      },
      deliveryThreadId: 'thr-expired',
    });

    await spec.run.execute('wake now', 'thread-thr-expired', {
      assignedCatId: null,
      async deliver(opts) {
        delivered.push(opts);
        return 'wake-message-id';
      },
      ballCustody: {
        async record(event) {
          events.push(event);
        },
      },
    });

    assert.equal(delivered.length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'ball.hold_expired');
    assert.equal(events[0].sourceEventId, `holdexp:thr-expired:codex:${fireAt}`);
    assert.equal(events[0].subjectKey, 'ball:thread:thr-expired');
    assert.deepEqual(events[0].payload, { catId: 'codex', fireAt });
  });
});
