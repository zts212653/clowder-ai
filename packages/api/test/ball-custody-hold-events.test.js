/**
 * F117 Phase G — managed hold no longer mutates ordinary Ball custody.
 *
 * Action-successor custody keeps its explicit Ball event log, while managed
 * hold state is owned by the persistent Message/Task lifecycle. These tests
 * pin the two former integration points so the retired parallel projection
 * cannot be reintroduced accidentally.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F117 Phase G: managed hold stays out of ordinary Ball custody', () => {
  test('POST /api/callbacks/hold-ball persists lifecycle state without recording ball.held', async () => {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const registry = new InvocationRegistry();
    const invocationRecordStore = new InvocationRecordStore();
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
        invocationRecordStore,
        ballCustody: {
          async record(event) {
            events.push(event);
          },
        },
      },
    });

    const thread = await threadStore.create('user-f233-held', 'f233-held');
    const parent = invocationRecordStore.create({
      threadId: thread.id,
      userId: 'user-f233-held',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'f280-phase-d-action-owner',
      actionLeaseCarrier: { kind: 'action_successor', leaseId: 'lease-f280-action', generation: 4 },
    });
    const { invocationId, callbackToken } = await registry.create(
      'user-f233-held',
      'codex',
      thread.id,
      parent.invocationId,
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'waiting on CI',
        nextStep: 'check status',
        wakeAfterMs: 60_000,
        waitSourceRef: {
          kind: 'github_issue',
          value: 'test/ball-custody#12',
          expectedSignal: 'ci_complete',
          slaUntilMs: 3_600_000,
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(events, []);
    const awaitState = insertedTasks[0].params.holdLifecycle.await;
    assert.ok(awaitState, 'timer hold must persist the unified wait shape');
    assert.deepEqual(insertedTasks[0].params.holdLifecycle, {
      mode: 'timer',
      status: 'active',
      waitSourceRef: {
        kind: 'github_issue',
        value: 'test/ball-custody#12',
        expectedSignal: 'ci_complete',
        slaUntilMs: 3_600_000,
      },
      subjectKey: 'test/ball-custody#12',
      expectedSignalKey: 'ci_complete',
      wakeAt: insertedTasks[0].trigger.fireAt,
      createdBy: 'hold-ball:codex',
      await: {
        v: 1,
        generation: 1,
        subjectRef: `timer:${insertedTasks[0].id}`,
        ownerFence: { kind: 'action_successor', leaseId: 'lease-f280-action', generation: 4 },
        baseline: {
          kind: 'timer',
          capturedAt: awaitState.createdAt,
          fireAt: insertedTasks[0].trigger.fireAt,
        },
        continuation: {
          when: [{ kind: 'timer_elapsed' }],
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
          then: 'check status',
        },
        expiresAt: insertedTasks[0].trigger.fireAt,
        createdAt: awaitState.createdAt,
        provenance: 'explicit_registration',
      },
    });
  });

  test('hold-ball reminder fire queues its wake without recording ball.hold_expired', async () => {
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
    assert.deepEqual(events, []);
  });
});
