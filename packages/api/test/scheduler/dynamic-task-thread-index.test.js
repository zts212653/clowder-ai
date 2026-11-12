import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';

// dynamic_task_defs lives in the evidence database and keeps every historical hold, reminder and
// managed command with large JSON columns. Hold-ball and thread task reads run synchronously on the
// API thread, so a full scan here reads overflow pages for the whole history on every call.
function plannedThreadReads() {
  const db = new Database(':memory:');
  applyMigrations(db);
  const store = new DynamicTaskStore(db);
  const statements = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    statements.push(sql);
    return prepare(sql);
  };
  store.findByDeliveryThread('thread-probe');
  store.findByDeliveryThreadAndCreatedBy('thread-probe', 'hold-ball:probe');
  db.prepare = prepare;
  return {
    db,
    plans: statements.map((sql) => ({
      sql,
      plan: db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...['thread-probe', 'hold-ball:probe'].slice(0, sql.split('?').length - 1))
        .map((row) => row.detail),
    })),
  };
}

test('thread task reads use an index on delivery_thread_id and need no sort pass', (t) => {
  const { db, plans } = plannedThreadReads();
  t.after(() => db.close());
  assert.equal(plans.length, 2, 'both thread readers must issue their SQL through this store');
  for (const { sql, plan } of plans) {
    const detail = plan.join(' | ');
    assert.ok(!/\bSCAN dynamic_task_defs\b/.test(detail), `${sql} scans the task table: ${detail}`);
    assert.ok(/USING INDEX \S*delivery_thread/.test(detail), `${sql} does not use a thread index: ${detail}`);
    assert.ok(!detail.includes('USE TEMP B-TREE FOR ORDER BY'), `${sql} sorts outside the index: ${detail}`);
  }
});
