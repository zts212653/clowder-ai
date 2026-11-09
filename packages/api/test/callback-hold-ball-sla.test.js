import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { HoldQuotaStore } from '../dist/domains/ball-custody/hold-quota-store.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../dist/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../dist/infrastructure/scheduler/TaskRunnerV2.js';
import { reminderTemplate } from '../dist/infrastructure/scheduler/templates/reminder.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackHoldBallRoutes } from '../dist/routes/callback-hold-ball-routes.js';
import { isolateManagedJobData } from './helpers/isolated-managed-job-data.js';

isolateManagedJobData();
const NOW = 1_800_000_000_000;
const DELAY = 5_000;

async function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const db = new Database(':memory:');
  applyMigrations(db);
  const store = new DynamicTaskStore(db);
  const ledger = new RunLedger(db);
  const quota = new HoldQuotaStore({ dbPath: ':memory:' });
  const registry = new InvocationRegistry();
  const threadStore = new ThreadStore();
  const thread = await threadStore.create('sla-owner', 'hold SLA');
  const auth = await registry.create(
    'sla-owner',
    'codex',
    thread.id,
    undefined,
    undefined,
    undefined,
    undefined,
    'strict',
  );
  const messages = new MessageStore();
  const deliveries = [];
  const notices = [];
  const runner = new TaskRunnerV2({
    logger: { info() {}, error() {} },
    ledger,
    dynamicTaskStore: store,
    notifyLifecycle: (notice) => notices.push(notice),
    deliver: async (input) => {
      deliveries.push(input);
      const saved = await messages.append({
        ...input,
        from: { kind: 'system', service: 'hold-ball' },
        mentions: [],
        timestamp: Date.now(),
      });
      return saved.id;
    },
  });
  const app = Fastify();
  registerCallbackAuthHook(app, registry);
  registerCallbackHoldBallRoutes(app, {
    registry,
    threadStore,
    taskRunner: runner,
    dynamicTaskStore: store,
    holdQuotaStore: quota,
    templateRegistry: { get: () => reminderTemplate },
    messageStore: messages,
    socketManager: { broadcastToRoom() {} },
  });
  t.after(async () => {
    runner.stop();
    await app.close();
    quota.close();
    db.close();
  });
  const hold = (slaUntilMs) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        reason: 'wait for external CI',
        nextStep: 'recheck CI',
        wakeAfterMs: DELAY,
        waitSourceRef: { kind: 'task', value: 'external-ci', expectedSignal: 'ci_complete', slaUntilMs },
      },
    });
  return { app, store, ledger, quota, runner, hold, deliveries, notices, thread };
}

for (const gap of [-69, 0]) {
  test(`rejects SLA ${gap}ms after planned wake without consuming quota or replacing the current hold`, async (t) => {
    const f = await fixture(t);
    const first = await f.hold(NOW + DELAY + 60_000);
    assert.equal(first.statusCode, 200);
    const id = first.json().taskId;
    const rejected = await f.hold(NOW + DELAY + gap);
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().code, 'HOLD_SLA_NOT_AFTER_WAKE');
    assert.equal(rejected.json().wakeAt, NOW + DELAY);
    assert.equal(rejected.json().slaUntilMs, NOW + DELAY + gap);
    assert.match(rejected.json().action, /slaUntilMs/);
    assert.equal(f.store.getAll().length, 1);
    assert.equal(f.store.getById(id).params.holdLifecycle.status, 'active');
    assert.equal(await f.quota.getCount(f.thread.id, 'codex', 3_600_000), 1);
    assert.deepEqual(f.runner.getRegisteredTasks(), [id]);
  });
}

test('accepted online hold wakes exactly once despite 5ms callback jitter, with only 1ms of planned margin', async (t) => {
  const f = await fixture(t);
  const accepted = await f.hold(NOW + DELAY + 1);
  assert.equal(accepted.statusCode, 200);
  const id = accepted.json().taskId;
  f.runner.start();
  t.mock.timers.setTime(NOW + 5);
  t.mock.timers.tick(DELAY);
  await setImmediate();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].source.meta.phase, 'wake');
  assert.equal(f.deliveries[0].targetCatId, 'codex');
  assert.equal(f.ledger.query(id, 1)[0].outcome, 'RUN_DELIVERED');
  assert.equal(f.store.getById(id).params.holdLifecycle.status, 'fired');
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(f.deliveries.length, 1);
});

for (const mode of ['recovery expiry', 'invalid persisted window', 'busy defer']) {
  test(`${mode} preserves a terminal failure receipt without invoking the cat`, async (t) => {
    const f = await fixture(t);
    const accepted = await f.hold(NOW + DELAY + 10);
    assert.equal(accepted.statusCode, 200);
    const id = accepted.json().taskId;
    if (mode === 'recovery expiry') {
      f.runner.unregister(id);
      t.mock.timers.setTime(NOW + DELAY + 1);
      assert.equal(f.runner.hydrateDynamic(f.store, { get: () => reminderTemplate }), 1);
      t.mock.timers.setTime(NOW + DELAY + 11);
      f.runner.start();
      t.mock.timers.tick(0);
    } else if (mode === 'invalid persisted window') {
      f.runner.unregister(id);
      const params = f.store.getById(id).params;
      params.holdLifecycle.waitSourceRef.slaUntilMs = NOW + DELAY - 69;
      params.holdLifecycle.await.expiresAt = NOW + DELAY - 69;
      f.store.updateParams(id, params);
      assert.equal(f.runner.hydrateDynamic(f.store, { get: () => reminderTemplate }), 1);
      f.runner.start();
      t.mock.timers.tick(DELAY);
    } else {
      f.runner.setBusyChecker(() => true);
      f.runner.start();
      t.mock.timers.tick(DELAY);
    }
    await setImmediate();
    const terminal = f.store.getById(id);
    assert.equal(terminal.enabled, false);
    assert.match(terminal.params.holdLifecycle.status, /^retired_(expired|invalid)$/);
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].source.meta.phase, 'status');
    assert.equal(f.deliveries[0].targetCatId, undefined);
    assert.match(f.deliveries[0].content, /截止|窗口/);
    assert.doesNotMatch(f.deliveries[0].content, /服务未运行/);
    assert.equal(f.notices.length, 1);
    assert.ok(!f.runner.getRegisteredTasks().includes(id));
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(f.deliveries.length, 1);
  });
}
