import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ManagedCommandWakeRecoveryEngine } from '../src/domains/ball-custody/ManagedCommandWakeRecoveryEngine.js';
import { createManagedCommandWakeCarrierAdapter } from '../src/domains/ball-custody/managed-command-wake-carrier-adapter.js';
import { applyMigrations } from '../src/domains/memory/schema.js';
import { DynamicTaskStore } from '../src/infrastructure/scheduler/DynamicTaskStore.js';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.js';

function task(id, catId = 'opus') {
  return {
    id: `hold-ball-${id}`,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 99_000 },
    params: {
      message: 'fallback',
      triggerUserId: 'user-1',
      targetCatId: catId,
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        createdBy: `hold-ball:${catId}`,
        wakeAt: 99_000,
        managedCommand: {
          state: 'condition_met',
          command: 'owned fixture',
          startedAt: 1000,
          conditionMetAt: 2000,
          wakeContent: 'owned completion',
        },
      },
    },
    display: { label: 'owned fixture', category: 'system', description: 'C6 canonical retirement' },
    deliveryThreadId: 'thread-c6-retirement',
    enabled: true,
    createdBy: `hold-ball:${catId}`,
    createdAt: new Date(1000).toISOString(),
  };
}

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'a2a-c6-retirement-'));
  const db = new Database(join(root, 'scheduler.sqlite'));
  applyMigrations(db);
  const tasks = new DynamicTaskStore(db);
  const f = createPersistedQueueFixture();
  const unregistered = [];
  let admissions = 0;
  const adapter = createManagedCommandWakeCarrierAdapter({
    messageStore: f.messages,
    invocationRecordStore: f.records,
    invocationQueue: f.queue,
  });
  const engine = new ManagedCommandWakeRecoveryEngine({
    dynamicTaskStore: tasks,
    messageStore: f.messages,
    socketManager: { broadcastToRoom() {} },
    taskRunner: { unregister: (id) => unregistered.push(id) },
    invocationRecordStore: f.records,
    ...adapter,
    now: () => 10_000,
    async admitWake(input) {
      admissions++;
      // Same atomic canonical admission as index; a controlled provider proves actual child exposure.
      const admitted = await f.queue.send(f.messages, input.message, {
        threadId: input.threadId,
        userId: input.userId,
        sourceId: input.message.idempotencyKey,
        kind: 'conversation_input',
        ownerAuthProvenance: 'unknown',
        idempotencyKey: input.message.idempotencyKey,
        content: input.content,
        from: input.message.from,
        targetCats: [input.catId],
        intent: 'execute',
        priority: input.priority,
        sourceCategory: input.sourceCategory,
      });
      assert.notEqual(admitted.outcome, 'full');
      await f.processor.progressOwnedCarrier(admitted.entry, input.catId);
      return { messageId: admitted.message.id };
    },
  });
  t.after(async () => {
    await f.close();
    db.close();
  });
  t.diagnostic(`Owned SQLite retained: ${root}`);
  return { f, tasks, engine, adapter, unregistered, admissions: () => admissions };
}

async function publish(h, definition) {
  h.tasks.insert(definition);
  assert.equal(await h.engine.recoverTask(definition.id), 'pending');
  const persisted = h.tasks.getById(definition.id);
  const messageId = persisted.params.holdLifecycle.managedCommand.messageId;
  const childId = await h.f.waitForAwakening(messageId);
  return { messageId, childId };
}

test('canonical failed History drains only its exact wake and never re-injects on replay', async (t) => {
  const h = harness(t);
  const firstTask = task('first');
  const siblingTask = task('sibling', 'codex');
  const first = await publish(h, firstTask);
  const sibling = await publish(h, siblingTask);
  assert.notEqual(first.messageId, sibling.messageId);
  await h.f.close(); // Real child failure, NOT Task/business success.
  const beforeHistory = structuredClone(h.f.messages.getById(first.messageId));
  assert.equal(await h.engine.recoverTask(firstTask.id), 'recovered');
  const consumed = h.tasks.getById(firstTask.id);
  assert.equal(consumed.enabled, false);
  assert.equal(consumed.params.holdLifecycle.managedCommand.state, 'consumed');
  assert.equal(consumed.params.holdLifecycle.managedCommand.invocationId, first.childId);
  assert.equal(consumed.params.holdLifecycle.managedCommand.carrierTerminalReason, 'failed');
  assert.equal(h.tasks.getById(siblingTask.id).enabled, true, 'sibling Task is not retired by a different source');
  assert.deepEqual(h.f.messages.getById(first.messageId), beforeHistory, 'retirement does not rewrite History');
  assert.equal(
    (await h.f.queue.getDurableEntriesForMessages(firstTask.deliveryThreadId, [first.messageId, sibling.messageId]))
      .size,
    0,
    'actual dispatch retired Queue targets',
  );
  const count = h.admissions();
  assert.equal(await h.engine.recoverTask(firstTask.id), 'missing');
  assert.equal(h.engine.retireTask(firstTask.id, 'failed', first.messageId), false);
  assert.equal(h.admissions(), count);
  assert.equal(h.f.starts.length, 2);
  assert.deepEqual(h.unregistered, [firstTask.id]);
  assert.equal(await h.engine.recoverTask(siblingTask.id), 'recovered');
  assert.equal(h.tasks.getById(siblingTask.id).params.holdLifecycle.managedCommand.invocationId, sibling.childId);
});

test('a running exact child stays pending, without a second admission or retirement', async (t) => {
  const h = harness(t);
  const def = task('running');
  const { messageId } = await publish(h, def);
  await Promise.all([h.engine.recoverTask(def.id), h.engine.recoverTask(def.id)]);
  assert.equal(h.tasks.getById(def.id).enabled, true);
  assert.deepEqual(h.unregistered, []);
  assert.equal(h.admissions(), 1);
  assert.equal(h.f.starts.length, 1);
  assert.equal(
    (await h.adapter.getEventCarrier({ threadId: def.deliveryThreadId, userId: 'user-1', catId: 'opus', messageId }))
      .state,
    'pending',
  );
});

test('exact source and target scope fence retirement independently of Ball order', async (t) => {
  const h = harness(t);
  const def = task('scope');
  const { messageId } = await publish(h, def);
  await h.f.close();
  for (const scope of [{ threadId: 'foreign-thread' }, { userId: 'foreign-user' }, { catId: 'foreign-cat' }]) {
    const carrier = await h.adapter.getEventCarrier({
      threadId: def.deliveryThreadId,
      userId: 'user-1',
      catId: 'opus',
      messageId,
      ...scope,
    });
    assert.ok(carrier.state === 'missing' || carrier.state === 'orphaned');
  }
  const before = h.tasks.getById(def.id);
  assert.equal(h.engine.retireTask(def.id, 'failed', 'foreign-source'), false);
  assert.deepEqual(h.tasks.getById(def.id), before);
  assert.equal(h.engine.retireTask(def.id, 'failed', messageId), true);
  assert.equal(h.engine.retireTask(def.id, 'failed', messageId), false);
  assert.equal(h.admissions(), 1);
});

test('old source cannot retire a replaced persisted claim generation', async (t) => {
  const h = harness(t);
  const def = task('generation');
  const { messageId } = await publish(h, def);
  const before = h.tasks.getById(def.id);
  const next = structuredClone(before.params);
  Object.assign(next.holdLifecycle.managedCommand, { messageId: 'replacement-source', messageClaimGeneration: 2 });
  assert.equal(h.tasks.updateParamsIfCurrent(def.id, before.params, next), true);
  assert.equal(
    h.tasks.updateParamsIfCurrent(def.id, before.params, before.params),
    false,
    'stale CAS cannot restore old identity',
  );
  assert.equal(h.engine.retireTask(def.id, 'failed', messageId), false);
  assert.deepEqual(h.tasks.getById(def.id).params, next);
  assert.equal(h.tasks.getById(def.id).enabled, true);
});

test('concurrent failed consumption uses persisted CAS and unregisters once', async (t) => {
  const h = harness(t);
  const def = task('concurrent');
  await publish(h, def);
  await h.f.close();
  const outcomes = await Promise.all([h.engine.recoverTask(def.id), h.engine.recoverTask(def.id)]);
  assert.equal(outcomes.filter((outcome) => outcome === 'recovered').length, 1);
  assert.equal(h.tasks.getById(def.id).enabled, false);
  assert.deepEqual(h.unregistered, [def.id]);
  assert.equal(h.admissions(), 1);
  assert.equal(h.f.starts.length, 1);
});
