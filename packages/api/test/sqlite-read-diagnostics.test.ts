import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  createSqliteReadDiagnostics,
  type SqliteReadDiagnostic,
} from '../src/infrastructure/sqlite-read-diagnostics.js';

test('slow .all reports SQL fingerprint and caller without bound values, literal SQL or returned bodies', () => {
  const db = new Database(':memory:');
  const reports: SqliteReadDiagnostic[] = [];
  let clock = 0;
  const stop = createSqliteReadDiagnostics({ onSlowRead: (event) => reports.push(event), clock: () => (clock += 150) })(
    db,
  );
  try {
    const sql = "SELECT ? AS content, 'literal-body-canary' AS literal";
    assert.deepEqual(db.prepare(sql).all('bound-body-canary'), [
      { content: 'bound-body-canary', literal: 'literal-body-canary' },
    ]);
    assert.equal(reports.length, 1, 'native slow read must leave an attributable witness');
    assert.equal(reports[0]?.sqlFingerprint, createHash('sha256').update(sql).digest('hex'));
    assert.equal(reports[0]?.databasePath, ':memory:');
    assert.equal(reports[0]?.rows, 1);
    assert.equal(reports[0]?.requestId, null, 'an unavailable request context is unknown');
    assert(reports[0]?.caller.some((frame) => frame.includes('sqlite-read-diagnostics.test.ts')));
    assert(!JSON.stringify(reports).includes('body-canary'));
  } finally {
    stop();
    db.close();
  }
});

test('shared report budget and repeated callsite cap keep logging bounded across connections', () => {
  const reports: SqliteReadDiagnostic[] = [];
  const observe = createSqliteReadDiagnostics({
    onSlowRead: (event) => reports.push(event),
    minDurationMs: 0,
    maxReports: 3,
    maxPerCallsite: 1,
  });
  const db = new Database(':memory:');
  const other = new Database(':memory:');
  const stop = observe(db);
  const stopOther = observe(other);
  try {
    const statement = db.prepare('SELECT 1 AS kept');
    for (let i = 0; i < 50; i++) statement.all();
    assert.equal(reports.length, 1);
    for (let i = 0; i < 10; i++) other.prepare(`SELECT ${i} AS kept`).all();
    assert.equal(reports.length, 3);
    assert.deepEqual(statement.all(), [{ kept: 1 }]);
  } finally {
    stop();
    stopOther();
    db.close();
    other.close();
  }
});

test('fast reads produce no report and detach stops reporting existing prepared statements', () => {
  const reports: SqliteReadDiagnostic[] = [];
  const db = new Database(':memory:');
  let elapsed = 5;
  let calls = 0;
  const originalPrepare = db.prepare;
  const stop = createSqliteReadDiagnostics({
    onSlowRead: (event) => reports.push(event),
    clock: () => (calls++ % 2 === 0 ? 0 : elapsed),
  })(db);
  try {
    const statement = db.prepare('SELECT 1');
    statement.all();
    assert.equal(reports.length, 0);
    elapsed = 150;
    statement.all();
    assert.equal(reports.length, 1);
    stop();
    assert.equal(db.prepare, originalPrepare);
    statement.all();
    assert.equal(reports.length, 1);
  } finally {
    stop();
    db.close();
  }
});

test('native receiver, bind, pluck, raw, safe integers and errors survive observer and logger failures', () => {
  const db = new Database(':memory:');
  const stop = createSqliteReadDiagnostics({
    onSlowRead: () => {
      throw new Error('sink-down');
    },
    minDurationMs: 0,
  })(db);
  try {
    assert.deepEqual(db.prepare('SELECT ? AS n').bind(4).all(), [{ n: 4 }]);
    assert.deepEqual(db.prepare('SELECT ? AS n').pluck().all(5), [5]);
    assert.deepEqual(db.prepare('SELECT ? AS n').raw().all(6), [[6]]);
    assert.deepEqual(db.prepare('SELECT 7 AS n').safeIntegers().all(), [{ n: 7n }]);
    const statement = db.prepare('SELECT ? AS n');
    assert.deepEqual(statement.all.bind(statement)(8), [{ n: 8 }]);
    const expected = new Error('native-error-canary');
    db.function('broken', () => {
      throw expected;
    });
    assert.throws(
      () => db.prepare('SELECT broken()').all(),
      (error) => error === expected,
    );
    assert.throws(() => statement.all(), /Too few parameter values/);
  } finally {
    stop();
    db.close();
  }
});

test('request context does not leak into unrelated background reads', async () => {
  const context = new AsyncLocalStorage<string>();
  const reports: SqliteReadDiagnostic[] = [];
  const db = new Database(':memory:');
  const stop = createSqliteReadDiagnostics({
    onSlowRead: (event) => reports.push(event),
    minDurationMs: 0,
    getRequestId: () => context.getStore() ?? null,
  })(db);
  try {
    await Promise.all(
      ['req-a', 'req-b'].map((id) =>
        context.run(id, async () => {
          await new Promise((resolve) => setImmediate(resolve));
          db.prepare('SELECT 1').all();
        }),
      ),
    );
    db.prepare('SELECT 2').all();
    assert.deepEqual(
      reports.map((report) => report.requestId),
      ['req-a', 'req-b', null],
    );
  } finally {
    stop();
    db.close();
  }
});

test('an interrupted native read has a bounded start witness before it can return', () => {
  const db = new Database(':memory:');
  const events: { phase: string; evidence: unknown }[] = [];
  const stop = createSqliteReadDiagnostics({
    onSlowRead() {},
    maxReports: 2,
    onReadStarted: (evidence) => events.push({ phase: 'start', evidence }),
    onReadFinished: (evidence) => events.push({ phase: 'finish', evidence }),
  })(db);
  try {
    db.function('check_before_return', () => {
      assert.equal(events.at(-1)?.phase, 'start', 'a killed .all must already have an attributable witness');
      return 'private-returned-canary';
    });
    const statement = db.prepare('SELECT check_before_return() AS content, ? AS bound');
    for (let i = 0; i < 2; i++) assert.equal(statement.all('private-binding-canary').length, 1);
    assert.deepEqual(
      events.map((e) => e.phase),
      ['start', 'finish', 'start', 'finish'],
    );
    assert.doesNotMatch(JSON.stringify(events), /private-|SELECT|check_before_return/);
    db.prepare('SELECT 3').all();
    assert.equal(events.length, 4, 'start and finish pairs share one bounded observation budget');
  } finally {
    stop();
    db.close();
  }
});

test('start metadata and paired diagnostic sink failures cannot replace native results', () => {
  for (const metadataFails of [false, true]) {
    const db = new Database(':memory:');
    const fail = () => {
      throw new Error('diagnostic unavailable');
    };
    const stop = createSqliteReadDiagnostics({
      onSlowRead: fail,
      onReadStarted: fail,
      onReadFinished: fail,
      ...(metadataFails ? { getRequestId: fail } : {}),
    })(db);
    try {
      assert.deepEqual(db.prepare('SELECT ? AS n').all(42), [{ n: 42 }]);
      const original = new Error('native failure');
      db.function('broken_native', () => {
        throw original;
      });
      assert.throws(
        () => db.prepare('SELECT broken_native()').all(),
        (error) => error === original,
      );
    } finally {
      stop();
      db.close();
    }
  }
});
