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

async function fixture(t, rejectStatus = false) {
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
      if (rejectStatus && input.source?.meta.phase === 'status') throw new Error('status sink unavailable');
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
    ownerUserId: 'sla-owner',
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
  const hold = (slaUntilMs, wakeAfterMs = DELAY) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        reason: 'wait for external CI',
        nextStep: 'recheck CI',
        wakeAfterMs,
        waitSourceRef: { kind: 'task', value: 'external-ci', expectedSignal: 'ci_complete', slaUntilMs },
      },
    });
  return { app, store, ledger, quota, runner, hold, deliveries, notices, thread, messages };
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

test('accepted online hold wakes exactly once with 25ms jitter inside its 600ms deadline margin', async (t) => {
  const f = await fixture(t);
  const accepted = await f.hold(NOW + DELAY + 600);
  assert.equal(accepted.statusCode, 200);
  const id = accepted.json().taskId;
  f.runner.start();
  t.mock.timers.setTime(NOW + 25);
  t.mock.timers.tick(DELAY);
  await setImmediate();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].source.meta.phase, 'wake');
  assert.equal(f.deliveries[0].source.meta.cancelable, false);
  assert.equal(f.deliveries[0].targetCatId, 'codex');
  assert.equal(f.ledger.query(id, 1)[0].outcome, 'RUN_DELIVERED');
  assert.equal(f.store.getById(id).params.holdLifecycle.status, 'fired');
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(f.deliveries.length, 1);
});

for (const jump of [120_000, 28_800_000]) {
  test(`strict timer crossing its deadline during async admission by ${jump}ms retains an expired original hold`, async (t) => {
    const f = await fixture(t, true);
    const tryAdmit = f.quota.tryAdmit.bind(f.quota);
    t.mock.method(f.quota, 'tryAdmit', async (...args) => {
      const admitted = await tryAdmit(...args);
      t.mock.timers.setTime(NOW + jump);
      return admitted;
    });
    const deadline = NOW + 8_600;
    const accepted = await f.hold(deadline, 8_000);
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().held, true);
    const id = accepted.json().taskId;
    assert.equal(f.store.getPrivateOwnerAuthProvenance(id), 'strict');
    assert.equal(f.store.getById(id).params.holdLifecycle.await.expiresAt, deadline);
    f.runner.start();
    t.mock.timers.tick(0);
    await setImmediate();
    assert.equal(f.deliveries.filter((delivery) => delivery.targetCatId).length, 0);
    assert.equal(f.ledger.query(id, 1).length, 0);
    const terminal = f.store.getById(id);
    assert.notEqual(terminal, null);
    assert.equal(terminal.enabled, false);
    assert.equal(terminal.params.holdLifecycle.status, 'retired_expired');
    assert.equal(terminal.params.holdLifecycle.dispositionReason, 'sla_elapsed');
    assert.equal(f.runner.getRegisteredTasks().includes(id), false);
    assert.equal((await f.messages.getByThread(f.thread.id, 10, 'sla-owner')).length, 1);
    const status = await f.app.inject({
      method: 'GET',
      url: `/api/callbacks/hold-ball/${id}/status`,
      headers: { 'x-cat-cafe-user': 'sla-owner' },
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().status, 'retired_expired');
    assert.equal(status.json().cancelable, false);
    assert.equal(status.json().lifecycle.dispositionReason, 'sla_elapsed');
    assert.equal(f.deliveries.length, 0);
  });
}

for (const jump of [5, 120_000, 28_800_000]) {
  test(`online hold does not wake past its absolute deadline after ${jump}ms clock delay`, async (t) => {
    const f = await fixture(t);
    const accepted = await f.hold(NOW + DELAY + (jump === 5 ? 1 : 600));
    assert.equal(accepted.statusCode, 200);
    const id = accepted.json().taskId;
    f.runner.start();
    t.mock.timers.setTime(NOW + jump);
    t.mock.timers.tick(DELAY);
    await setImmediate();
    assert.equal(f.deliveries.filter((delivery) => delivery.targetCatId).length, 0);
    assert.equal(f.ledger.query(id, 1).length, 0);
    assert.equal(f.store.getById(id).params.holdLifecycle.status, 'retired_expired');
    assert.equal(f.store.getById(id).params.holdLifecycle.dispositionReason, 'sla_elapsed');
    assert.equal(f.deliveries[0].source.meta.phase, 'status');
  });
}

test('original waiting hold retains its failure reason when the optional status notification is rejected', async (t) => {
  const f = await fixture(t, true);
  const accepted = await f.hold(NOW + DELAY + 600);
  const id = accepted.json().taskId;
  f.runner.unregister(id);
  t.mock.timers.setTime(NOW + DELAY + 601);
  assert.equal(f.runner.hydrateDynamic(f.store, { get: () => reminderTemplate }), 0);
  await setImmediate();
  assert.equal(f.deliveries.length, 0);
  const history = await f.messages.getByThread(f.thread.id, 10, 'sla-owner');
  assert.equal(history.length, 1);
  assert.equal(
    (await f.messages.getByIdempotencyKey('sla-owner', f.thread.id, `hold-ball-waiting:${id}`)).id,
    history[0].id,
  );
  const status = await f.app.inject({
    method: 'GET',
    url: `/api/callbacks/hold-ball/${id}/status`,
    headers: { 'x-cat-cafe-user': 'sla-owner' },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().status, 'retired_expired');
  assert.equal(status.json().cancelable, false);
  assert.equal(status.json().lifecycle.dispositionReason, 'sla_elapsed');
  const restored = new TaskRunnerV2({ logger: { info() {}, error() {} }, ledger: f.ledger, dynamicTaskStore: f.store });
  assert.equal(restored.hydrateDynamic(f.store, { get: () => reminderTemplate }), 0);
  restored.stop();
  assert.equal(f.deliveries.length, 0);
});

test('a fresh HTTP hold can continue after expiry while the original waiting receipt stays readable', async (t) => {
  const f = await fixture(t, true);
  const first = await f.hold(NOW + DELAY + 600);
  assert.equal(first.statusCode, 200);
  const firstId = first.json().taskId;
  const original = (await f.messages.getByThread(f.thread.id, 10, 'sla-owner'))[0];
  f.runner.start();
  t.mock.timers.setTime(NOW + 120_000);
  t.mock.timers.tick(DELAY);
  await setImmediate();

  const followUp = await f.hold(Date.now() + DELAY + 1_200);
  assert.equal(followUp.statusCode, 200);
  const followUpId = followUp.json().taskId;
  assert.notEqual(followUpId, firstId);
  t.mock.timers.tick(DELAY);
  await setImmediate();
  assert.equal(f.deliveries.length, 1, 'the rejected status receipt is not required to continue');
  assert.equal(f.deliveries[0].targetCatId, 'codex');
  assert.equal(f.store.getById(followUpId).params.holdLifecycle.status, 'fired');
  const status = await f.app.inject({
    method: 'GET',
    url: `/api/callbacks/hold-ball/${firstId}/status`,
    headers: { 'x-cat-cafe-user': 'sla-owner' },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().status, 'retired_expired');
  assert.equal(status.json().lifecycle.dispositionReason, 'sla_elapsed');
  const history = await f.messages.getByThread(f.thread.id, 10, 'sla-owner');
  const same = history.find((message) => message.id === original.id);
  assert.equal(same.content, original.content);
  assert.equal(same.source.meta.taskId, firstId);
  assert.equal(same.source.meta.phase, 'waiting');
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(f.deliveries.length, 1, 'only the new hold wakes, exactly once');
});

for (const mode of [
  'recovery expiry',
  'missed expiry',
  'invalid persisted window',
  'invalid missed window',
  'busy defer',
]) {
  test(`${mode} preserves a terminal failure receipt without invoking the cat`, async (t) => {
    const f = await fixture(t);
    const accepted = await f.hold(NOW + DELAY + 10);
    assert.equal(accepted.statusCode, 200);
    const id = accepted.json().taskId;
    if (mode === 'recovery expiry' || mode === 'missed expiry') {
      f.runner.unregister(id);
      t.mock.timers.setTime(NOW + DELAY + (mode === 'missed expiry' ? 11 : 1));
      assert.equal(f.runner.hydrateDynamic(f.store, { get: () => reminderTemplate }), mode === 'missed expiry' ? 0 : 1);
      t.mock.timers.setTime(NOW + DELAY + 11);
      f.runner.start();
      t.mock.timers.tick(0);
    } else if (mode === 'invalid persisted window' || mode === 'invalid missed window') {
      f.runner.unregister(id);
      const params = f.store.getById(id).params;
      params.holdLifecycle.waitSourceRef.slaUntilMs = NOW + DELAY - 69;
      params.holdLifecycle.await.expiresAt = NOW + DELAY - 69;
      f.store.updateParams(id, params);
      if (mode === 'invalid missed window') t.mock.timers.setTime(NOW + DELAY + 1);
      assert.equal(
        f.runner.hydrateDynamic(f.store, { get: () => reminderTemplate }),
        mode === 'invalid missed window' ? 0 : 1,
      );
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
    if (mode === 'invalid missed window') {
      assert.equal(terminal.params.holdLifecycle.status, 'retired_invalid');
      assert.equal(terminal.params.holdLifecycle.dispositionReason, 'sla_not_after_wake');
      assert.doesNotMatch(f.notices[0].toast.message, /服务.*未运行/);
    }
    if (mode === 'missed expiry') {
      assert.equal(terminal.params.holdLifecycle.status, 'retired_expired');
      assert.equal(terminal.params.holdLifecycle.dispositionReason, 'sla_elapsed');
      assert.match(f.deliveries[0].content, /超过等待截止/);
      assert.doesNotMatch(f.notices[0].toast.message, /服务.*未运行/);
    }
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].source.meta.phase, 'status');
    assert.equal(f.deliveries[0].source.meta.cancelable, false);
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

for (const invalid of [false, true]) {
  test(`strict online hold without onceLifecycle ${invalid ? 'rejects an invalid window' : 'still wakes once'}`, async (t) => {
    const f = await fixture(t);
    const accepted = await f.hold(NOW + DELAY + 10);
    const id = accepted.json().taskId;
    f.runner.unregister(id);
    const def = f.store.getById(id);
    if (invalid) {
      delete def.params.triggerUserId;
      def.params.holdLifecycle.waitSourceRef.slaUntilMs = NOW + DELAY - 69;
      def.params.holdLifecycle.await.expiresAt = NOW + DELAY - 69;
      f.store.updateParams(id, def.params);
    }
    const spec = reminderTemplate.createSpec(id, { ...def, ...f.store.getPrivateOwnerAuthorization(id) });
    assert.equal(spec.onceLifecycle, undefined);
    f.runner.register(spec);
    f.runner.start();
    t.mock.timers.tick(DELAY);
    await setImmediate();
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].source.meta.phase, invalid ? 'status' : 'wake');
    assert.equal(f.deliveries[0].source.meta.cancelable, false);
    assert.equal(f.deliveries[0].targetCatId, invalid ? undefined : 'codex');
    if (invalid) {
      assert.equal(f.store.getById(id).params.holdLifecycle.status, 'retired_invalid');
      assert.equal(f.store.getById(id).params.holdLifecycle.dispositionReason, 'sla_not_after_wake');
      assert.equal(f.notices.length, 1);
      assert.equal(f.deliveries[0].userId, 'default-user');
    }
    assert.ok(!f.runner.getRegisteredTasks().includes(id));
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(f.deliveries.length, 1);
  });
}

for (const expired of [false, true]) {
  test(`unknown-provenance online timer ${expired ? 'past its deadline' : 'inside its window'} retains legacy execution`, async (t) => {
    const f = await fixture(t);
    const id = 'hold-ball-legacy-unknown';
    const fireAt = NOW + DELAY;
    const deadline = fireAt + 600;
    const def = {
      id,
      templateId: 'reminder',
      trigger: { type: 'once', fireAt },
      params: {
        message: 'legacy hold',
        triggerUserId: 'sla-owner',
        targetCatId: 'codex',
        holdLifecycle: {
          mode: 'timer',
          status: 'active',
          wakeAt: fireAt,
          waitSourceRef: { slaUntilMs: deadline },
          await: {
            subjectRef: `timer:${id}`,
            generation: 1,
            expiresAt: deadline,
            baseline: { kind: 'timer', fireAt },
            continuation: { when: [{ kind: 'timer_elapsed' }] },
          },
        },
      },
      display: { label: 'legacy hold', category: 'system', subjectKind: 'none' },
      deliveryThreadId: f.thread.id,
      enabled: true,
      createdBy: 'hold-ball:codex',
      createdAt: NOW,
    };
    // The old writer omitted private authorization; do not forge a new strict registration.
    f.store.insert(def);
    assert.equal(f.store.getPrivateOwnerAuthProvenance(id), 'unknown');
    const spec = reminderTemplate.createSpec(id, { ...def, ...f.store.getPrivateOwnerAuthorization(id) });
    assert.equal(spec.onceLifecycle, undefined);
    f.runner.register(spec);
    f.runner.start();
    if (expired) t.mock.timers.setTime(NOW + 120_000);
    t.mock.timers.tick(DELAY);
    await setImmediate();
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].targetCatId, 'codex');
    assert.equal(f.deliveries[0].source.meta.phase, 'wake');
    assert.equal(f.ledger.query(id, 1)[0].outcome, 'RUN_DELIVERED');
    assert.equal(f.store.getById(id), null);
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(f.deliveries.length, 1);
  });
}
