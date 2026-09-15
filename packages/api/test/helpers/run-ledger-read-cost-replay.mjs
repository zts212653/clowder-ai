/** Replay the observed count distribution using synthetic rows in an owned temporary SQLite DB. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { applyMigrations, SCHEMA_V5 } from '../../dist/domains/memory/schema.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { replayScheduleHttp, seedScheduleDefinitions } from './schedule-scale-http-replay.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const base = process.argv[2];
if (!base || !/^[a-f0-9]{40}$/.test(base)) throw new Error('Pass the full pre-fix Git commit SHA');
const shape = JSON.parse(
  readFileSync(
    join(repoRoot, 'docs/bug-report/2026-09-09-local-navigation-stall-attribution/schedule-scale-shape.json'),
    'utf8',
  ),
);
const scratch = mkdtempSync(join(tmpdir(), 'cat-cafe-ledger-scale-'));
let db;
try {
  const previousSource = execFileSync(
    'git',
    ['show', `${base}:packages/api/src/infrastructure/scheduler/RunLedger.ts`],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const previousModule = join(scratch, 'RunLedger.before.mjs');
  writeFileSync(
    previousModule,
    ts.transpileModule(previousSource, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );
  const { RunLedger: PreviousRunLedger } = await import(pathToFileURL(previousModule).href);
  db = new Database(join(scratch, 'scale.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_V5);
  db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version VALUES (44, '2026-09-08T00:00:00Z');`);
  const insert = db.prepare(`WITH RECURSIVE rows(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < ?
  ) INSERT INTO task_run_ledger
    (task_id, subject_key, outcome, signal_summary, duration_ms, started_at)
    SELECT ?, 'synthetic-subject', ?, ?, 1, '2026-09-08T00:00:00Z' FROM rows`);
  const taskIds = Array.from({ length: shape.taskCount }, (_, index) => `synthetic-task-${index}`);
  const seedStart = performance.now();
  db.transaction(() => {
    shape.nonzeroTasks.forEach((task, index) => {
      for (const [outcome, count] of [
        ['RUN_DELIVERED', task.delivered],
        ['RUN_FAILED', task.failed],
        ['SKIP_NO_SIGNAL', task.skipped],
        ['SKIP_GLOBAL_PAUSE', task.total - task.delivered - task.failed - task.skipped],
      ]) {
        if (count > 0) insert.run(count, taskIds[index], outcome, 'x'.repeat(task.summaryBytes));
      }
    });
  })();
  const seedMs = performance.now() - seedStart;
  const rows = db.prepare('SELECT COUNT(*) AS count FROM task_run_ledger').get().count;
  assert.equal(rows, shape.retainedRunCount);
  const dynamicTaskStore = seedScheduleDefinitions(db, taskIds);
  const readAll = (ledger) => taskIds.map((id) => ledger.stats(id));
  const run = (ledger) => {
    const timings = [];
    let result;
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      result = readAll(ledger);
      timings.push(Number((performance.now() - start).toFixed(3)));
    }
    return { timings, result };
  };
  const previous = run(new PreviousRunLedger(db));
  const previousHttp = await replayScheduleHttp(new PreviousRunLedger(db), dynamicTaskStore, taskIds);
  const migrationStart = performance.now();
  applyMigrations(db);
  const migrationMs = performance.now() - migrationStart;
  const current = run(new RunLedger(db));
  const currentHttp = await replayScheduleHttp(new RunLedger(db), dynamicTaskStore, taskIds);
  assert.deepEqual(current.result, previous.result);
  assert.equal(currentHttp.body, previousHttp.body);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_run_ledger').get().count, rows);
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  process.stdout.write(
    `${JSON.stringify(
      {
        baselineCommit: base,
        measuredAt: new Date().toISOString(),
        scope:
          'all schedule counter reads using actual old/new RunLedger; synthetic rows with observed count distribution',
        taskCount: taskIds.length,
        retainedRunCount: rows,
        seedMs: Number(seedMs.toFixed(3)),
        oneTimeMigrationMs: Number(migrationMs.toFixed(3)),
        oldReadMs: previous.timings,
        newReadMs: current.timings,
        oldMedianMs: median(previous.timings),
        newMedianMs: median(current.timings),
        completeStatsIdentical: true,
        completeHttpBodyIdentical: true,
        httpBytes: currentHttp.bytes,
        oldHttpMs: previousHttp.timings,
        newHttpMs: currentHttp.timings,
        oldConcurrentHealthMs: previousHttp.healthTimings,
        newConcurrentHealthMs: currentHttp.healthTimings,
        retainedRowsUnchanged: true,
        newQueryPlan: db
          .prepare('EXPLAIN QUERY PLAN SELECT total, delivered, failed, skipped FROM task_run_stats WHERE task_id = ?')
          .all(taskIds[0]),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  db?.close();
  rmSync(scratch, { recursive: true, force: true });
}
