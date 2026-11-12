import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../../src/infrastructure/scheduler/RunLedger.js';
import { SCHEDULE_LIST_FILTER } from '../../src/infrastructure/scheduler/schedule-list-schema.js';
import { TaskRunnerV2 } from '../../src/infrastructure/scheduler/TaskRunnerV2.js';
import { scheduleRoutes } from '../../src/routes/schedule.js';
import { isVisibleDynamicTaskDef } from '../../src/routes/schedule-route-support.js';
import { countHydratedRows, definition, template } from '../helpers/dynamic-task-read-cost-fixture.js';

test('schedule polling decodes and queries only live definitions while history stays durable', async (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const store = new DynamicTaskStore(db);
  db.transaction(() => {
    for (let i = 0; i < 1000; i++) {
      store.insert({
        ...definition(`hold-ball-history-${i}`, false, 'reminder'),
        createdBy: 'hold-ball:codex61-sol',
        params: {
          payload: 'x'.repeat(1000),
          holdLifecycle: { mode: 'timer', status: 'fired', createdBy: 'hold-ball:codex61-sol' },
        },
      });
    }
  })();
  const historical = db.prepare('SELECT * FROM dynamic_task_defs WHERE id = ?').get('hold-ball-history-0');
  const ledger = new RunLedger(db);
  const runner = new TaskRunnerV2({ ledger, logger: { info() {}, error() {} } });
  const app = Fastify();
  t.after(async () => {
    runner.stop();
    await app.close();
    db.close();
  });
  await app.register(scheduleRoutes, { taskRunner: runner, dynamicTaskStore: store });
  store.insert(definition('paused-user', false));
  store.insert({
    ...definition('hold-ball-active', true, 'reminder'),
    createdBy: 'hold-ball:codex61-sol',
    params: { holdLifecycle: { mode: 'timer', status: 'active', createdBy: 'hold-ball:codex61-sol' } },
  });
  const queried: string[] = [];
  for (const method of ['query', 'stats'] as const) {
    const original = ledger[method].bind(ledger);
    t.mock.method(ledger, method, (id: string, limit?: number) => {
      queried.push(id);
      return original(id, limit as number);
    });
  }
  const reads = countHydratedRows(db);
  t.after(reads.stop);
  for (let i = 0; i < 2; i++) {
    const response = await app.inject({ method: 'GET', url: '/api/schedule/tasks' });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response
        .json()
        .tasks.map((task: { id: string }) => task.id)
        .sort(),
      ['hold-ball-active', 'paused-user'],
    );
  }
  assert(reads.counts.length > 0);
  assert(Math.max(...reads.counts) <= 2, `polling hydrated ${Math.max(...reads.counts)} definitions`);
  assert.equal(queried.length, 8, 'two ledger reads per live definition, per poll');
  assert(
    queried.every((id) => !id.startsWith('hold-ball-history-')),
    'history must never enter per-task ledger reads',
  );
  assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs WHERE id = ?').get('hold-ball-history-0'), historical);
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM dynamic_task_defs WHERE ${SCHEDULE_LIST_FILTER} ORDER BY created_at DESC`,
    )
    .all() as { detail: string }[];
  assert(
    plan.some((row) => row.detail.includes('idx_dynamic_schedule_list')),
    JSON.stringify(plan),
  );
});

test('schedule index migration is atomic, survives reopen, and preserves history for old readers', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'schedule-list-'));
  const path = join(root, 'history.sqlite');
  let db = new Database(path);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(db);
  db.exec('DROP INDEX idx_dynamic_schedule_list; DELETE FROM schema_version WHERE version >= 75');
  const store = new DynamicTaskStore(db);
  store.insert({
    ...definition('hold-ball-retired', false, 'reminder'),
    createdBy: 'hold-ball:codex61-sol',
    params: { holdLifecycle: { mode: 'timer', status: 'fired', createdBy: 'hold-ball:codex61-sol' } },
  });
  store.insert(definition('paused', false));
  const before = db.prepare('SELECT * FROM dynamic_task_defs ORDER BY id').all();
  db.exec(
    "CREATE TRIGGER fail_v75 BEFORE INSERT ON schema_version WHEN NEW.version = 75 BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  );
  assert.throws(() => applyMigrations(db), /injected failure/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_dynamic_schedule_list'").get(), undefined);
  assert.equal(db.prepare('SELECT version FROM schema_version WHERE version=75').get(), undefined);
  assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs ORDER BY id').all(), before);
  db.exec('DROP TRIGGER fail_v75');
  db.close();
  db = new Database(path);
  applyMigrations(db);
  applyMigrations(db);
  const reopened = new DynamicTaskStore(db);
  assert.deepEqual(
    reopened.getScheduleTasks().map((row) => row.id),
    ['paused'],
  );
  assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs ORDER BY id').all(), before);
  assert.equal(reopened.getAll().length, 2, 'old readers and exact-ID history retain both definitions');
});

test('indexed visibility agrees with canonical hold identity and lifecycle validation', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  applyMigrations(db);
  const store = new DynamicTaskStore(db);
  for (const [id, template, creator, lifecycle] of [
    ['hold-ball-active', 'reminder', 'hold-ball:c', { mode: 'timer', status: 'active', createdBy: 'c' }],
    [
      'hold-ball-cancelling',
      'reminder',
      'hold-ball:c',
      { mode: 'wake_when', status: 'cancel_requested', createdBy: 'c' },
    ],
    ['hold-ball-missing-creator', 'reminder', 'hold-ball:c', { mode: 'timer', status: 'fired' }],
    ['hold-ball-legacy', 'reminder', 'hold-ball:c', undefined],
    ['hold-ball-unknown', 'reminder', 'hold-ball:c', { mode: 'timer', status: 'unknown', createdBy: 'c' }],
    ['hold-ball-wrong-mode', 'reminder', 'hold-ball:c', { mode: 'other', status: 'fired', createdBy: 'c' }],
    ['hold-ball-wrong-template', 'fixture', 'hold-ball:c', { mode: 'timer', status: 'fired', createdBy: 'c' }],
    ['hold-ball-wrong-owner', 'reminder', 'user', { mode: 'timer', status: 'fired', createdBy: 'c' }],
    ['dyn-user', 'reminder', 'hold-ball:c', { mode: 'timer', status: 'fired', createdBy: 'c' }],
    ['hold-ball-ended', 'reminder', 'hold-ball:c', { mode: 'wake_when', status: 'fired', createdBy: 'c' }],
  ] as const) {
    store.insert({
      ...definition(id, true, template),
      createdBy: creator,
      params: lifecycle ? { holdLifecycle: lifecycle } : {},
    });
  }
  assert.deepEqual(store.getScheduleTasks(), store.getAll().filter(isVisibleDynamicTaskDef));
  assert.equal(store.getScheduleTasks().length, 9, 'only the valid terminal hold is hidden');
});

test('a stale registered terminal hold cannot reappear or be manually triggered', async (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const store = new DynamicTaskStore(db);
  const def = {
    ...definition('hold-ball-stale', true, 'reminder'),
    createdBy: 'hold-ball:c',
    params: { holdLifecycle: { mode: 'timer', status: 'fired', createdBy: 'c' } },
  };
  store.insert(def);
  const ledger = new RunLedger(db);
  const runner = new TaskRunnerV2({ ledger, logger: { info() {}, error() {} } });
  runner.registerDynamic(template.createSpec(def.id, { trigger: def.trigger, params: def.params }), def.id);
  const app = Fastify();
  t.after(async () => {
    runner.stop();
    await app.close();
    db.close();
  });
  await app.register(scheduleRoutes, { taskRunner: runner, dynamicTaskStore: store });
  assert.equal(runner.getRegisteredTasks().includes(def.id), true);
  const list = await app.inject({ method: 'GET', url: '/api/schedule/tasks' });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().tasks.length, 0, 'runtime registration must not revive a terminal definition');
  const trigger = await app.inject({ method: 'POST', url: `/api/schedule/tasks/${def.id}/trigger` });
  assert.equal(trigger.statusCode, 404, 'terminal holds cannot be manually resurrected');
  assert.equal(ledger.query(def.id, 10).length, 0);
});
