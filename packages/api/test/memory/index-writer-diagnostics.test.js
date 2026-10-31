import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { createIndexWriterDiagnostics } from '../helpers/index-writer-diagnostics.js';

const sourceId = '2026-03-13 10:38:09 737ae4a34738ffa0c3ff7f9bb18df914dd1cad163f28fd6b6e114a344fe6d618';
const row = {
  task_id: 'fixture',
  subject_key: 'live',
  outcome: 'delivered',
  signal_summary: null,
  duration_ms: 0,
  started_at: 1,
  assigned_cat_id: null,
};

function fixture({ prepareMs = 12, runMs = 103, supported = true, observerFails = false } = {}) {
  let wall = 0;
  let cpu = 0;
  let io = 0;
  let gc;
  let closed = false;
  let failure;
  let timedRegion = false;
  const calls = [];
  const database = {
    inTransaction: false,
    prepare(sql) {
      calls.push(['prepare', sql]);
      if (sql.includes('sqlite_version'))
        return { get: () => ({ version: supported ? '3.51.3' : 'unknown', sourceId }) };
      wall += prepareMs;
      return {
        run: (...args) => {
          calls.push(['run', args]);
          wall += runMs;
          cpu += 200;
          io += 3;
          if (failure) throw failure;
          return { changes: 1 };
        },
      };
    },
    pragma(sql) {
      assert.equal(timedRegion, false, 'no diagnostic SQL inside the original stopwatch');
      calls.push(['pragma', sql]);
      if (sql.includes('wal_checkpoint')) return [{ busy: 0, log: io ? 1002 : 998, checkpointed: io ? 1002 : 0 }];
      return { journal_mode: 'wal', synchronous: 1, wal_autocheckpoint: 1000, busy_timeout: 5000, page_size: 4096 }[
        sql
      ];
    },
  };
  const diagnostics = createIndexWriterDiagnostics(database, {
    now: () => wall,
    platform: 'fixture',
    cpuUsage: () => {
      assert.equal(timedRegion, false, 'no resource syscalls inside the original stopwatch');
      if (observerFails) throw new Error('secret-observer-error');
      return { user: cpu, system: 0 };
    },
    threadCpuUsage: () => null,
    resourceUsage: () => ({ fsRead: 0, fsWrite: io, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0 }),
    observeGc: (callback) => {
      gc = callback;
      return {
        drain() {},
        close() {
          closed = true;
        },
      };
    },
  });
  const ledger = new RunLedger(diagnostics.database);
  return {
    calls,
    database,
    diagnostics,
    ledger,
    now: () => wall,
    setTimedRegion: (value) => {
      timedRegion = value;
    },
    emitGc: (entry) => gc(entry),
    isClosed: () => closed,
    fail: (error) => {
      failure = error;
    },
  };
}

function write(f) {
  f.diagnostics.beforeWrite(16);
  const startedAt = f.now();
  f.setTimedRegion(true);
  try {
    f.ledger.record(row);
  } finally {
    const elapsedMs = f.now() - startedAt;
    f.setTimedRegion(false);
    f.diagnostics.afterWrite({ startedAt, elapsedMs });
  }
}

test('slow actual RunLedger call reports prepare/run, resources, transaction and guarded WAL without raw SQL', () => {
  const f = fixture();
  write(f);
  const report = f.diagnostics.summary();
  assert.equal(report.sampleCount, 1);
  assert.equal(report.worstWrite.elapsedMs, 115);
  assert.deepEqual(report.worstWrite.stages, { prepareMs: 12, runMs: 103 });
  assert.deepEqual(report.worstWrite.resources.processCpuUs, { user: 200, system: 0 });
  assert.equal(report.worstWrite.resources.io.fsWrite, 3);
  assert.equal(report.worstWrite.beforeTransaction, false);
  assert.equal(report.worstWrite.afterTransaction, false);
  assert.equal(report.worstWrite.walAfter.checkpointed, 1002);
  assert.equal(report.slowWriteCount, 1);
  assert.equal(report.observerErrors, 0);
  assert.equal(JSON.stringify(report).includes('INSERT'), false);
  assert.equal(f.calls.find(([kind]) => kind === 'run')[1][0], row.task_id);
  f.diagnostics.close();
});

test('fast writes add no SQL or WAL observation inside the original timed region and retain bounded samples', () => {
  const f = fixture({ prepareMs: 0.01, runMs: 0.02 });
  f.diagnostics.phase('thread-passages');
  const baselineCalls = f.calls.length;
  for (let i = 0; i < 100; i++) write(f);
  assert.equal(f.calls.length - baselineCalls, 200, 'only the original prepare/run calls per fast write');
  const report = f.diagnostics.summary();
  assert.equal(report.sampleCount, 100);
  assert.equal(report.slowWriteCount, 0);
  assert.equal(report.observerErrors, 0);
  assert.equal(report.slowWrites.length, 0);
  assert.ok(report.worstWrite.elapsedMs < 100);
  f.diagnostics.close();
});

test('unknown SQLite source never executes a possibly PASSIVE fallback NOOP mode', () => {
  const f = fixture({ supported: false });
  write(f);
  f.diagnostics.phase('thread-passages');
  const report = f.diagnostics.summary();
  assert.equal(report.sqlite.noopSupported, false);
  assert.equal(
    f.calls.some(([kind, sql]) => kind === 'pragma' && sql.includes('wal_checkpoint')),
    false,
  );
  assert.equal(report.worstWrite.walAfter, null);
  f.diagnostics.close();
});

test('GC overlaps and retention are numeric-only and closing removes the observer', () => {
  const f = fixture();
  write(f);
  f.emitGc({ startTime: 20, duration: 5, detail: { kind: 1 }, secret: 'do-not-publish' });
  for (let i = 0; i < 300; i++) f.emitGc({ startTime: 1000 + i, duration: 1 });
  const report = f.diagnostics.summary();
  assert.equal(report.worstWrite.gcOverlapMs, 5);
  assert.equal(report.gc.count, 301);
  assert.ok(report.gc.retained <= 256);
  assert.equal(JSON.stringify(report).includes('do-not-publish'), false);
  f.diagnostics.close();
  assert.equal(f.isClosed(), true);
});

test('observer failures do not swallow native errors or expose raw error text', () => {
  const f = fixture();
  const nativeError = new Error('secret-native-error');
  f.fail(nativeError);
  assert.throws(
    () => write(f),
    (error) => error === nativeError,
  );
  assert.equal(f.diagnostics.summary().worstWrite.stages.runMs, 103);
  assert.equal(JSON.stringify(f.diagnostics.summary()).includes('secret-native-error'), false);
  f.diagnostics.close();
});

test('optional resource observation failures stay numeric/null and do not change the native write', () => {
  const f = fixture({ observerFails: true });
  write(f);
  const report = f.diagnostics.summary();
  assert.equal(report.worstWrite.elapsedMs, 115);
  assert.equal(report.worstWrite.resources.processCpuUs, null);
  assert.ok(report.observerErrors > 0);
  assert.equal(JSON.stringify(report).includes('secret-observer-error'), false);
  f.diagnostics.close();
});

test('slow-write WAL sampling and retained failures are bounded without dropping the failure count', () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) write(f);
  const report = f.diagnostics.summary();
  assert.equal(report.sampleCount, 20);
  assert.equal(report.slowWriteCount, 20);
  assert.equal(report.slowWrites.length, 4);
  assert.equal(report.walSamples, 5, 'one setup baseline and at most four slow-after observations');
  f.diagnostics.close();
});
