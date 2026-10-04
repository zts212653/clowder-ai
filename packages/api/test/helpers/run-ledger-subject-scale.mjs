/** Synthetic incident-shape replay. Owns only its temporary SQLite DB and loopback HTTP server. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../dist/infrastructure/scheduler/TaskRunnerV2.js';
import { scheduleRoutes } from '../../dist/routes/schedule.js';
import './setup-cat-registry.js';

const rowCount = Number(process.argv[2] ?? 6_741_450);
assert.ok(Number.isSafeInteger(rowCount) && rowCount >= 40_000 && rowCount <= 10_000_000);
const root = mkdtempSync(join(tmpdir(), 'cat-cafe-subject-scale-'));
const db = new Database(join(root, 'synthetic.sqlite'));
const app = Fastify({ logger: false });
let runner;
try {
  db.pragma('journal_mode = WAL');
  applyMigrations(db);
  db.exec('DROP INDEX idx_run_ledger_task_subject; DELETE FROM schema_version WHERE version >= 50');
  const insert = db.prepare(`WITH RECURSIVE rows(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < ?
  ) INSERT INTO task_run_ledger (task_id, subject_key, outcome, signal_summary, duration_ms, started_at)
    SELECT ?, ?, 'SKIP_NO_SIGNAL', 'synthetic retained receipt', 1, '2026-10-02T00:00:00Z' FROM rows`);
  const seedStart = performance.now();
  db.transaction(() => {
    insert.run(38_856, 'shared-poller', 'pr:synthetic/repo#4089');
    insert.run(rowCount - 38_856, 'busy-ci', 'ci:synthetic');
  })();
  const seedMs = performance.now() - seedStart;
  const ledger = new RunLedger(db);
  const beforeStats = [ledger.stats('shared-poller'), ledger.stats('busy-ci')];
  const beforeSample = ledger.queryBySubject('shared-poller', 'pr:synthetic/repo#4089', 200);
  const migrationStart = performance.now();
  applyMigrations(db);
  const migrationMs = performance.now() - migrationStart;
  assert.deepEqual([ledger.stats('shared-poller'), ledger.stats('busy-ci')], beforeStats);
  assert.deepEqual(ledger.queryBySubject('shared-poller', 'pr:synthetic/repo#4089', 200), beforeSample);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_run_ledger').get().count, rowCount);

  const dynamicTaskStore = new DynamicTaskStore(db);
  db.transaction(() => {
    for (let i = 0; i < 3129; i += 1) {
      dynamicTaskStore.insert({
        id: `idle-${i}`,
        templateId: 'synthetic-disabled',
        trigger: { type: 'interval', ms: 60000 },
        params: {},
        display: { label: `Idle ${i}`, category: 'system', description: 'Synthetic replay' },
        deliveryThreadId: i === 0 ? 'target-thread' : null,
        enabled: false,
        createdBy: 'synthetic-owner',
        createdAt: '2026-10-02T00:00:00Z',
      });
    }
  })();
  runner = new TaskRunnerV2({ ledger, logger: { info() {}, error() {} } });
  runner.register({
    id: 'shared-poller',
    profile: 'poller',
    trigger: { type: 'interval', ms: 60000 },
    admission: { gate: async () => ({ run: false, reason: 'read-only fixture' }) },
    run: { overlap: 'skip', timeoutMs: 1000, execute: async () => {} },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => false,
  });
  const taskStore = {
    listByThread: async () =>
      Array.from({ length: 20 }, (_, i) => ({
        subjectKey: `pr:synthetic/repo#${4089 + i}`,
        status: 'doing',
      })),
  };
  await app.register(scheduleRoutes, { taskRunner: runner, dynamicTaskStore, taskStore });
  app.get('/health', async () => ({ ok: true }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const timings = [];
  for (let round = 0; round < 5; round += 1) {
    const start = performance.now();
    const [schedule, health] = await Promise.all([
      fetch(`${origin}/api/schedule/tasks?threadId=target-thread`).then(async (response) => {
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(
          body.tasks.map((task) => task.id),
          ['shared-poller', 'idle-0'],
        );
        return performance.now() - start;
      }),
      fetch(`${origin}/health`).then(async (response) => {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
        return performance.now() - start;
      }),
    ]);
    timings.push({ scheduleMs: Number(schedule.toFixed(3)), concurrentHealthMs: Number(health.toFixed(3)) });
  }
  const history = await fetch(`${origin}/api/schedule/tasks/shared-poller/runs?threadId=target-thread&limit=200`);
  assert.equal(history.status, 200);
  assert.deepEqual(
    (await history.json()).runs,
    beforeSample.map((row) => ({ ...row, threadId: null })),
  );
  assert.ok(
    timings.every((time) => time.concurrentHealthMs < 1000),
    JSON.stringify(timings),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        rowCount,
        dynamicTaskCount: 3129,
        distinctPrSubjects: 20,
        subjectKeysWithAliasesAndThread: 42,
        seedMs: Number(seedMs.toFixed(3)),
        migrationMs: Number(migrationMs.toFixed(3)),
        origin,
        timings,
        statsUnchanged: true,
        retainedRowsUnchanged: true,
        historySampleUnchanged: true,
        scope: 'Synthetic SQLite and real HTTP in isolated worktree; no production data or Redis touched.',
      },
      null,
      2,
    )}\n`,
  );
} finally {
  runner?.stop();
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
}
