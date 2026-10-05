import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { RunLedger } from '../dist/infrastructure/scheduler/RunLedger.js';
import { scheduleRoutes } from '../dist/routes/schedule.js';
import './helpers/setup-cat-registry.js';

async function fixture(t) {
  const queries = [];
  const db = new Database(':memory:', { verbose: (sql) => queries.push(sql) });
  applyMigrations(db);
  const ledger = new RunLedger(db);
  const summaries = [];
  const threadTasks = [{ subjectKey: 'pr:repo/app#1', status: 'doing' }];
  const runner = {
    getLedger: () => ledger,
    getTaskSummaries: () => summaries,
    getRegisteredTasks: () => summaries.map((summary) => summary.id),
  };
  const app = Fastify({ logger: false });
  await app.register(scheduleRoutes, { taskRunner: runner, taskStore: { listByThread: async () => threadTasks } });
  t.after(async () => {
    await app.close();
    db.close();
  });
  const addSummary = (id, overrides = {}) => {
    const summary = {
      id,
      lastRun: null,
      subjectPreview: null,
      runStats: { total: 0, delivered: 0, failed: 0, skipped: 0 },
      ...overrides,
    };
    summaries.push(summary);
    return summary;
  };
  const record = (taskId, subject, sequence, startedAt = '2026-10-02T00:00:00Z') =>
    ledger.record({
      task_id: taskId,
      subject_key: subject,
      outcome: 'RUN_DELIVERED',
      signal_summary: `kept-${sequence}`,
      duration_ms: sequence,
      started_at: startedAt,
      assigned_cat_id: null,
    });
  return { app, db, ledger, queries, summaries, threadTasks, addSummary, record };
}

test('thread schedule preserves delivery, older aliases and scrubbed kind matches with one membership read', async (t) => {
  const f = await fixture(t);
  f.addSummary('delivery', { deliveryThreadId: 'thread-one' });
  f.addSummary('latest', { lastRun: { subject_key: 'thread:thread-one' } });
  f.record('older', 'pr-repo/app#1', 1);
  f.record('older', 'pr:repo/app#99', 2);
  f.addSummary('older', { lastRun: f.ledger.query('older', 1)[0] });
  const unrelated = { subject_key: 'thread:other-thread' };
  f.addSummary('kind', {
    display: { subjectKind: 'pr' },
    lastRun: unrelated,
    subjectPreview: 'other-thread',
    runStats: { total: 99, delivered: 99, failed: 0, skipped: 0 },
  });
  f.addSummary('hidden');
  for (let i = 0; i < 40; i += 1) f.addSummary(`idle-${i}`);
  f.queries.length = 0;
  const response = await f.app.inject('/api/schedule/tasks?threadId=thread-one');
  assert.equal(response.statusCode, 200);
  const tasks = response.json().tasks;
  assert.deepEqual(
    tasks.map((task) => task.id),
    ['delivery', 'latest', 'older', 'kind'],
  );
  assert.deepEqual(tasks[2], f.summaries[2]);
  assert.deepEqual(tasks[3], {
    id: 'kind',
    display: { subjectKind: 'pr' },
    lastRun: null,
    subjectPreview: null,
    runStats: { total: 0, delivered: 0, failed: 0, skipped: 0 },
  });
  assert.equal(
    f.queries.filter((sql) => /\bFROM\s+task_run_ledger\b/i.test(sql)).length,
    1,
    'thread membership must use one batched lookup, independent of candidate count',
  );
});

test('thread run history keeps alias membership and started_at ordering', async (t) => {
  const f = await fixture(t);
  f.addSummary('history');
  f.record('history', 'pr:repo/app#1', 1, '2026-10-02T01:00:00Z');
  f.record('history', 'thread-thread-one', 2, '2026-10-02T03:00:00Z');
  f.record('history', 'pr-repo/app#1', 3, '2026-10-02T02:00:00Z');
  f.record('history', 'pr:repo/app#99', 4, '2026-10-02T04:00:00Z');
  const response = await f.app.inject('/api/schedule/tasks/history/runs?threadId=thread-one&limit=2');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().runs.map((run) => [run.duration_ms, run.threadId]),
    [
      [2, 'thread-one'],
      [3, null],
    ],
  );
});

test('negative and non-integer limits cannot turn a history read into an unbounded scan', async (t) => {
  const f = await fixture(t);
  f.addSummary('history');
  for (let i = 0; i < 60; i += 1) f.record('history', 'thread:thread-one', i);
  for (const limit of ['-1', '0.5', 'Infinity']) {
    const response = await f.app.inject(`/api/schedule/tasks/history/runs?limit=${limit}`);
    assert.equal(response.statusCode, 400, `invalid limit=${limit}`);
  }
});
