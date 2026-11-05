import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { cancelPendingHoldsForThread, retirePendingHoldsForSatisfiedWait } from '../../src/routes/hold-ball-cancel.js';
import { countHydratedRows, definition, history } from '../helpers/dynamic-task-read-cost-fixture.js';

function hold(id: string, threadId: string) {
  return {
    ...definition(id, true, 'reminder'),
    deliveryThreadId: threadId,
    createdBy: 'hold-ball:codex61-sol',
    params: { targetCatId: 'codex61-sol', triggerUserId: 'owner' },
  };
}
test('user-message cancellation reads only this thread and preserves running managed commands', (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  const store = new DynamicTaskStore(db);
  history(store);
  store.insert(hold('hold-ball-timer', 'target'));
  store.insert(hold('hold-ball-foreign', 'foreign'));
  store.insert({
    ...hold('hold-ball-command', 'target'),
    params: {
      targetCatId: 'codex61-sol',
      triggerUserId: 'owner',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        wakeAt: Date.now() + 60_000,
        createdBy: 'hold-ball:codex61-sol',
        managedCommand: { state: 'command_running', command: 'fixture command', startedAt: Date.now() - 10_000 },
      },
    },
  });
  const unregistered: string[] = [];
  const reads = countHydratedRows(db);
  t.after(reads.stop);
  const cancelled = cancelPendingHoldsForThread('target', {
    dynamicTaskStore: store,
    taskRunner: {
      unregister: (id) => {
        unregistered.push(id);
      },
    },
  });
  assert.deepEqual(
    cancelled.map((d) => d.id),
    ['hold-ball-timer'],
  );
  assert.deepEqual(unregistered, ['hold-ball-timer']);
  assert.equal(store.getById('hold-ball-foreign')?.enabled, true);
  assert.equal(store.getById('hold-ball-command')?.enabled, true);
  assert(reads.counts.length > 0);
  assert(Math.max(...reads.counts) <= 2, `cancel hydrated ${Math.max(...reads.counts)} definitions outside its thread`);
});

test('satisfied-wait retirement retains event matching and thread scope with a native bounded reader', (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  const store = new DynamicTaskStore(db);
  history(store);
  for (const [id, thread] of [
    ['hold-ball-match', 'target'],
    ['hold-ball-foreign', 'foreign'],
  ]) {
    store.insert({
      ...hold(id, thread),
      params: {
        targetCatId: 'codex61-sol',
        triggerUserId: 'owner',
        holdLifecycle: {
          mode: 'timer',
          status: 'active',
          createdBy: 'hold-ball:codex61-sol',
          subjectKey: 'zts212653/clowder-ai#1',
          expectedSignalKey: 'ci_complete',
          wakeAt: Date.now() + 60_000,
        },
      },
    });
  }
  const reads = countHydratedRows(db);
  t.after(reads.stop);
  const unregistered: string[] = [];
  const retired = retirePendingHoldsForSatisfiedWait(
    {
      threadId: 'target',
      subjectKey: 'zts212653/clowder-ai#1',
      expectedSignalKey: 'ci_complete',
      sourceKind: 'fixture',
    },
    {
      dynamicTaskStore: store,
      taskRunner: {
        unregister: (id) => {
          unregistered.push(id);
        },
      },
    },
  );
  assert.deepEqual(
    retired.map((d) => d.id),
    ['hold-ball-match'],
  );
  assert.deepEqual(unregistered, ['hold-ball-match']);
  assert.equal(store.getById('hold-ball-foreign')?.enabled, true);
  assert.equal(store.getById('hold-ball-match')?.enabled, false);
  assert(reads.counts.length > 0);
  assert(
    Math.max(...reads.counts) <= 1,
    `event retirement hydrated ${Math.max(...reads.counts)} definitions outside its thread`,
  );
});
