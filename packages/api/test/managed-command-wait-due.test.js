import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ManagedCommandWakeRecoverySweep } from '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { MANAGED_COMMAND_RECOVERY_INDEX } from '../dist/infrastructure/scheduler/managed-command/recovery-schema.js';
import { isolateManagedJobData } from './helpers/isolated-managed-job-data.js';
import { auditRecoverySqlite } from './helpers/recovery-store-audit.js';

isolateManagedJobData();

function task(n, settled = false) {
  return {
    id: `hold-ball-${String(n).padStart(5, '0')}`,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 1000 },
    params: {
      triggerUserId: 'owner',
      targetCatId: 'codex61-sol',
      holdLifecycle: {
        mode: 'wake_when',
        status: settled ? 'fired' : 'active',
        await: { v: 1, generation: 1 },
        managedCommand: { state: settled ? 'consumed' : 'command_running', command: 'original', startedAt: 0 },
      },
    },
    deliveryThreadId: 'thread',
    enabled: !settled,
    createdBy: 'hold-ball:codex61-sol',
    createdAt: new Date(n).toISOString(),
    display: { label: 'original', category: 'system', description: 'original' },
  };
}

test('the periodic wait selector caps real reads before decoding while settled history grows', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    const writer = new DynamicTaskStore(db);
    for (let n = 0; n < 12; n++) writer.insert(task(n));
    for (const count of [100, 1000]) {
      for (let n = count / 10; n < count; n++)
        if (!writer.getById(task(n + 100).id)) writer.insert(task(n + 100, true));
      const audit = auditRecoverySqlite(db);
      const reader = new DynamicTaskStore(audit.db);
      const due = reader.listManagedCommandCandidates(10, 2);
      assert.equal(due.length, 2, 'batch capacity covers SQL selection and hydration, not just the processing loop');
      audit.assertIndex('idx_dynamic_managed_recovery_due');
      assert.ok(
        audit.reads.every(({ plan }) =>
          plan.some(({ detail }) => /SEARCH.*idx_dynamic_managed_recovery_due/.test(detail)),
        ),
      );
    }
  } finally {
    db.close();
  }
});

test('five real delivery failures park the original wait without a second Message and survive due-index rebuilding', async () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    const store = new DynamicTaskStore(db);
    const waiting = task(42);
    waiting.params.holdLifecycle.managedCommand = {
      ...waiting.params.holdLifecycle.managedCommand,
      state: 'condition_met',
      conditionMetAt: 1,
      wakeContent: 'original result',
    };
    store.insert(waiting, { ownerAuthProvenance: 'strict' });
    const messages = new MessageStore();
    let now = 60_000;
    let admissions = 0;
    const sweep = new ManagedCommandWakeRecoverySweep({
      dynamicTaskStore: store,
      messageStore: messages,
      socketManager: { broadcastToRoom() {} },
      taskRunner: { unregister() {} },
      invocationRecordStore: { getByIdempotencyKey: () => null },
      now: () => now,
      admitWake: async () => {
        admissions++;
        throw new Error('durable storage refused the original admission');
      },
    });
    for (let n = 0; n < 5; n++) {
      await sweep.runOnce();
      now += 60_000;
    }
    const parked = store.getManagedCommandRecoveryState(waiting.id).fact;
    assert.equal(parked.attempts, 5);
    assert.equal(parked.disposition, 'parked');
    assert.equal(store.getById(waiting.id).params.holdLifecycle.managedCommand.state, 'condition_met');
    const legacy = store.getManagedCommandRecoveryState(waiting.id);
    assert.equal(
      store.updateManagedCommandRecoveryState(waiting.id, legacy.revision, {
        ...legacy.fact,
        nextAttemptAt: now,
        notification: { key: 'legacy-wait-notice', reasonCode: 'wake_admission_failed', attempts: 1 },
      }),
      true,
    );
    await sweep.runOnce();
    const upgraded = store.getManagedCommandRecoveryState(waiting.id).fact;
    assert.equal(upgraded.notification, undefined, 'upgrade retires the old notification outbox in place');
    assert.equal(upgraded.nextAttemptAt, null, 'upgrade removes the disposed wait from the due index');
    db.exec('DROP INDEX idx_dynamic_managed_recovery_due');
    db.exec(MANAGED_COMMAND_RECOVERY_INDEX);
    for (let n = 0; n < 10; n++) {
      await sweep.runOnce();
      now += 60_000;
    }
    assert.equal(admissions, 5, 'retired automatic work cannot be revived by rebuilding its index');
    assert.equal(messages.getByThread('thread').length, 0, 'the original wait remains the only visible owner');
    assert.deepEqual(store.listManagedCommandCandidates(now, 100), []);
    const original = store.getById(waiting.id);
    store.updateParamsIfCurrent(waiting.id, original.params, {
      ...original.params,
      holdLifecycle: { ...original.params.holdLifecycle, await: { v: 1, generation: 2 } },
    });
    assert.equal(
      store.getManagedCommandRecoveryState(waiting.id).fact.disposition,
      undefined,
      'a replacement generation must not inherit the prior disposition',
    );
    for (let n = 0; n < 5; n++) {
      await sweep.runOnce();
      now += 60_000;
    }
    assert.equal(admissions, 10);
    assert.equal(
      messages.getByThread('thread').length,
      0,
      'a distinct generation still cannot create a status Message',
    );
  } finally {
    db.close();
  }
});

test('explicit recheck resumes the original admission when its parked result has no Message yet', async () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    const store = new DynamicTaskStore(db);
    const waiting = task(4242);
    waiting.params.holdLifecycle.managedCommand = {
      ...waiting.params.holdLifecycle.managedCommand,
      state: 'condition_met',
      conditionMetAt: 1,
      wakeContent: 'original result',
    };
    store.insert(waiting, { ownerAuthProvenance: 'strict' });
    const messages = new MessageStore();
    let now = 60_000;
    let admissionAvailable = false;
    let admissions = 0;
    const sweep = new ManagedCommandWakeRecoverySweep({
      dynamicTaskStore: store,
      messageStore: messages,
      socketManager: { broadcastToRoom() {} },
      taskRunner: { unregister() {} },
      invocationRecordStore: { getByIdempotencyKey: () => null },
      now: () => now,
      admitWake: async (input) => {
        admissions++;
        if (!admissionAvailable) throw new Error('original admission unavailable');
        const stored = messages.append(input.message);
        return { messageId: stored.id };
      },
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      await sweep.runOnce();
      now += 60_000;
    }
    assert.equal(store.getManagedCommandRecoveryState(waiting.id).fact.disposition, 'parked');
    assert.equal(store.getById(waiting.id).params.holdLifecycle.managedCommand.messageId, undefined);
    assert.equal(messages.getByThread('thread').length, 0);

    admissionAvailable = true;
    let snapshot = store.getManagedCommandRecoveryState(waiting.id);
    assert.equal(
      store.updateManagedCommandRecoveryState(waiting.id, snapshot.revision, {
        ...snapshot.fact,
        waitGeneration: 2,
      }),
      true,
    );
    assert.equal(await sweep.recoverTask(waiting.id, true), 'pending');
    assert.equal(admissions, 5, 'a stale generation cannot replay the saved result');
    assert.equal(store.getById(waiting.id).params.holdLifecycle.managedCommand.messageId, undefined);
    snapshot = store.getManagedCommandRecoveryState(waiting.id);
    assert.equal(
      store.updateManagedCommandRecoveryState(waiting.id, snapshot.revision, {
        ...snapshot.fact,
        waitGeneration: 1,
      }),
      true,
    );
    assert.equal(await sweep.recoverTask(waiting.id, true), 'pending');
    const recovered = store.getById(waiting.id).params.holdLifecycle.managedCommand;
    assert.equal(recovered.state, 'enqueued');
    assert.equal(typeof recovered.messageId, 'string');
    assert.equal(messages.getById(recovered.messageId).content, '[定时任务] original result');
    assert.equal(store.getManagedCommandRecoveryState(waiting.id).fact.disposition, undefined);
    assert.equal(admissions, 6, 'recheck retries only the original production intent');
  } finally {
    db.close();
  }
});

test('explicit recheck separately observes an existing original Message without admitting another one', async () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    const store = new DynamicTaskStore(db);
    const waiting = task(4343);
    waiting.params.holdLifecycle.managedCommand = {
      ...waiting.params.holdLifecycle.managedCommand,
      state: 'condition_met',
      conditionMetAt: 1,
      wakeContent: 'original result',
    };
    store.insert(waiting, { ownerAuthProvenance: 'strict' });
    const messages = new MessageStore();
    let carrier = { state: 'pending' };
    let admissions = 0;
    const sweep = new ManagedCommandWakeRecoverySweep({
      dynamicTaskStore: store,
      messageStore: messages,
      socketManager: { broadcastToRoom() {} },
      taskRunner: { unregister() {} },
      invocationRecordStore: { getByIdempotencyKey: () => null },
      now: () => 60_000,
      getEventCarrier: async () => carrier,
      admitWake: async (input) => {
        admissions++;
        const stored = messages.append(input.message);
        return { messageId: stored.id };
      },
    });
    assert.equal(await sweep.recoverTask(waiting.id), 'pending');
    const admitted = store.getById(waiting.id).params.holdLifecycle.managedCommand;
    assert.equal(admitted.state, 'enqueued');
    assert.equal(typeof admitted.messageId, 'string');
    const snapshot = store.getManagedCommandRecoveryState(waiting.id);
    assert.equal(
      store.updateManagedCommandRecoveryState(waiting.id, snapshot.revision, {
        ...snapshot.fact,
        disposition: 'parked',
        reasonCode: 'carrier_unresolved',
        recheck: { kind: 'observe_original_wait', taskId: waiting.id },
        nextAttemptAt: null,
      }),
      true,
    );

    carrier = { state: 'handled', invocationId: 'original-invocation' };
    assert.equal(await sweep.recoverTask(waiting.id, true), 'recovered');
    const consumed = store.getById(waiting.id).params.holdLifecycle.managedCommand;
    assert.equal(consumed.state, 'consumed');
    assert.equal(consumed.invocationId, 'original-invocation');
    assert.equal(store.getManagedCommandRecoveryState(waiting.id).fact.disposition, undefined);
    assert.equal(admissions, 1, 'an existing Message remains the one original delivery owner');
    assert.ok(messages.getById(admitted.messageId));
  } finally {
    db.close();
  }
});

test('long healthy waits and batch deferral preserve zero failures for visited and unvisited owners', async () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    const store = new DynamicTaskStore(db);
    for (let n = 0; n < 120; n++) store.insert(task(n));
    let now = 1000;
    const sweep = new ManagedCommandWakeRecoverySweep({
      dynamicTaskStore: store,
      messageStore: new MessageStore(),
      socketManager: { broadcastToRoom() {} },
      taskRunner: { unregister() {} },
      invocationRecordStore: { getByIdempotencyKey: () => null },
      now: () => now,
      isCommandRunnerActive: () => true,
    });
    for (let n = 0; n < 10; n++) {
      await sweep.runOnce();
      now += 24 * 60 * 60_000;
    }
    for (let n = 0; n < 120; n++) {
      const fact = store.getManagedCommandRecoveryState(task(n).id).fact;
      assert.equal(fact.attempts, 0);
      assert.equal(fact.disposition, undefined);
      assert.equal(store.getById(task(n).id).params.holdLifecycle.managedCommand.state, 'command_running');
    }
  } finally {
    db.close();
  }
});

test('an admission capacity deferral is waiting rather than a delivery error', async () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    const store = new DynamicTaskStore(db);
    const waiting = task(999);
    waiting.params.holdLifecycle.managedCommand = {
      ...waiting.params.holdLifecycle.managedCommand,
      state: 'condition_met',
      conditionMetAt: 1,
      wakeContent: 'original result',
    };
    store.insert(waiting);
    let now = 1000;
    let deferred = 0;
    const messages = new MessageStore();
    const sweep = new ManagedCommandWakeRecoverySweep({
      dynamicTaskStore: store,
      messageStore: messages,
      now: () => now,
      socketManager: { broadcastToRoom() {} },
      taskRunner: { unregister() {} },
      invocationRecordStore: { getByIdempotencyKey: () => null },
      admitWake: async () => {
        deferred++;
        return {};
      },
    });
    for (let n = 0; n < 10; n++) {
      await sweep.runOnce();
      now += 60_000;
    }
    assert.equal(deferred, 10);
    assert.equal(store.getManagedCommandRecoveryState(waiting.id).fact.attempts, 0);
    assert.equal(store.getManagedCommandRecoveryState(waiting.id).fact.disposition, undefined);
    assert.equal(messages.getByThread('thread').length, 0);
  } finally {
    db.close();
  }
});
