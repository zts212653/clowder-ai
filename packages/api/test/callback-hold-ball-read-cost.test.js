import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

await import('tsx/esm');
const { HoldQuotaStore } = await import('../src/domains/ball-custody/hold-quota-store.js');
const { InvocationRegistry } = await import('../src/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { ThreadStore } = await import('../src/domains/cats/services/stores/ports/ThreadStore.js');
const { applyMigrations } = await import('../src/domains/memory/schema.js');
const { DynamicTaskStore } = await import('../src/infrastructure/scheduler/DynamicTaskStore.js');
const { countHydratedRows, definition, history } = await import('./helpers/dynamic-task-read-cost-fixture.js');

const target = process.env.CAT_CAFE_READ_COST_TARGET === 'dist' ? 'dist' : 'src';
const { callbacksRoutes } = await import(`../${target}/routes/callbacks.js`);

for (const registrationFails of [false, true]) {
  test(`hold replacement reads only its thread/cat definitions; registration failure=${registrationFails}`, async (t) => {
    const db = new Database(':memory:');
    applyMigrations(db);
    t.after(() => db.close());
    const store = new DynamicTaskStore(db);
    history(store);
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('fixture-owner', 'reader-cost');
    const catId = 'codex61-sol';
    const prior = {
      ...definition('hold-ball-prior', true, 'reminder'),
      deliveryThreadId: thread.id,
      createdBy: `hold-ball:${catId}`,
      params: { holdLifecycle: { mode: 'timer', status: 'active', createdBy: `hold-ball:${catId}` } },
    };
    const foreignThread = { ...prior, id: 'hold-ball-other-thread', deliveryThreadId: 'other-thread' };
    const foreignCat = { ...prior, id: 'hold-ball-other-cat', createdBy: 'hold-ball:sonnet' };
    for (const row of [prior, foreignThread, foreignCat]) store.insert(row);
    const registry = new InvocationRegistry();
    const quota = new HoldQuotaStore({ dbPath: ':memory:' });
    t.after(() => quota.close());
    const calls = [];
    const holdBallDeps = {
      registry,
      dynamicTaskStore: store,
      threadStore,
      ownerUserId: 'fixture-owner',
      holdQuotaStore: quota,
      taskRunner: {
        registerDynamic(_spec, taskId) {
          if (registrationFails) throw new Error('fixture registration failure');
          calls.push(['register', taskId]);
        },
        unregister(taskId) {
          calls.push(['unregister', taskId]);
        },
      },
      templateRegistry: { get: () => ({ createSpec: (id) => ({ id }) }) },
      messageStore: { append: async (message) => ({ ...message, id: 'fixture-message' }) },
      socketManager: { broadcastToRoom() {} },
    };
    const app = Fastify();
    t.after(() => app.close());
    await app.register(callbacksRoutes, {
      registry,
      threadStore,
      holdBallDeps,
      messageStore: holdBallDeps.messageStore,
      evidenceStore: { store: async () => {}, search: async () => [] },
      markerQueue: { enqueue() {} },
      reflectionService: { run: async () => {} },
    });
    const actor = await registry.create('fixture-owner', catId, thread.id);
    const reads = countHydratedRows(db);
    t.after(reads.stop);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': actor.invocationId, 'x-callback-token': actor.callbackToken },
      payload: {
        reason: 'fixture wait',
        nextStep: 'read fixture result',
        wakeAfterMs: 60000,
        waitSourceRef: {
          kind: 'github_issue',
          value: 'zts212653/clowder-ai#1',
          expectedSignal: 'ci_complete',
          slaUntilMs: Date.now() + 3600000,
        },
      },
    });
    assert.equal(response.statusCode, registrationFails ? 500 : 200);
    assert.equal(store.getById(foreignThread.id).enabled, true);
    assert.equal(store.getById(foreignCat.id).enabled, true);
    assert.equal(store.getById(prior.id).enabled, registrationFails);
    if (registrationFails)
      assert(
        calls.every((call) => call[1] !== prior.id),
        'failed replacement must not unregister prior',
      );
    else {
      assert.equal(calls[0][0], 'register');
      assert.deepEqual(calls[1], ['unregister', prior.id]);
      assert.equal(store.getById(prior.id).params.holdLifecycle.status, 'retired_by_replacement');
    }
    assert(reads.counts.length > 0);
    assert(
      Math.max(...reads.counts) <= 1,
      `hold replacement hydrated ${Math.max(...reads.counts)} history definitions`,
    );
  });
}
