import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { HOLD_WAIT_CANDIDATE_FILTER } from '../../src/infrastructure/scheduler/hold-wait-candidate-schema.js';
import { countHydratedRows, definition } from '../helpers/dynamic-task-read-cost-fixture.js';

function hold(id: string, enabled: boolean, status: string) {
  return {
    ...definition(id, enabled, 'reminder'),
    createdBy: 'hold-ball:codex61-sol',
    params: {
      payload: 'x'.repeat(1000),
      triggerUserId: 'user-a',
      holdLifecycle: { mode: 'timer', status, createdBy: 'hold-ball:codex61-sol' },
    },
  };
}

test('the 4-second execution poll decodes only armed holds and rides the schedule-list index', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  applyMigrations(db);
  const store = new DynamicTaskStore(db);
  db.transaction(() => {
    for (let i = 0; i < 1000; i++) store.insert(hold(`hold-ball-history-${i}`, false, 'fired'));
  })();
  store.insert(hold('hold-ball-armed', true, 'active'));
  store.insert(definition('ordinary-reminder', true, 'reminder'));
  store.insert(definition('paused-user', false));

  const reads = countHydratedRows(db);
  t.after(reads.stop);
  assert.deepEqual(
    store.listHoldWaitCandidates().map((task) => task.id),
    ['hold-ball-armed'],
  );
  assert.deepEqual(reads.counts, [1], 'only the armed hold is hydrated');

  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT * FROM dynamic_task_defs WHERE ${HOLD_WAIT_CANDIDATE_FILTER}`)
    .all() as { detail: string }[];
  assert(
    plan.some((row) => row.detail.includes('idx_dynamic_schedule_list')),
    JSON.stringify(plan),
  );
});
