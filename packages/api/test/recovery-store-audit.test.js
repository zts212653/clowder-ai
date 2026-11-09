import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { auditRecoveryRedis, auditRecoverySqlite } from './helpers/recovery-store-audit.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

test('the SQLite auditor checks the queries actually executed, including a hidden full-history read', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY, due_at INTEGER, terminal INTEGER);
      CREATE INDEX jobs_due ON jobs(due_at) WHERE terminal=0;
      INSERT INTO jobs VALUES ('live', 10, 0), ('history', 1, 1)`);
    const audit = auditRecoverySqlite(database);
    assert.deepEqual(audit.db.prepare('SELECT id FROM jobs WHERE terminal=0 AND due_at <= ?').all(20), [
      { id: 'live' },
    ]);
    audit.assertIndex('jobs_due');
    // A selector can have an indexed name/first query and still read all historical rows afterward.
    audit.db.prepare('WITH historical AS (SELECT id FROM jobs) SELECT * FROM historical').all();
    assert.throws(() => audit.assertIndex('jobs_due'), /full table scan/);
  } finally {
    database.close();
  }
});

test('zero pending results do not hide a full scan as settled JSON history grows', () => {
  for (const history of [1_000, 10_000]) {
    const database = new Database(':memory:');
    try {
      database.exec(`CREATE TABLE requests(id INTEGER PRIMARY KEY, record_json TEXT);
        CREATE INDEX requests_owner ON requests(json_extract(record_json, '$.owner'));
        WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n < ${history})
        INSERT INTO requests SELECT n, '{"owner":"cat","state":"bound"}' FROM rows`);
      const audit = auditRecoverySqlite(database);
      const result = audit.db
        .prepare("SELECT * FROM requests WHERE json_extract(record_json, '$.state')='pending'")
        .all();
      assert.equal(result.length, 0);
      assert.throws(() => audit.assertIndex('requests_due'), /full table scan/);
    } finally {
      database.close();
    }
  }
});

test(
  'server-side Redis audit sees SMEMBERS all inside a real Lua selector',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'recovery store audit');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: 'recovery-audit:' });
    const audit = await auditRecoveryRedis(redis);
    try {
      await redis.eval("return redis.call('SMEMBERS', KEYS[1])", 1, 'action:successor:all');
      await audit.flush();
      assert.throws(() => audit.assertIndexed(), /SMEMBERS all/);
    } finally {
      audit.stop();
      await redis.quit();
    }
  },
);

test('audits the real scheduler candidate selector and rejects substituting the historical reader', async () => {
  const { applyMigrations } = await import('../dist/domains/memory/schema.js');
  const { DynamicTaskStore } = await import('../dist/infrastructure/scheduler/DynamicTaskStore.js');
  const database = new Database(':memory:');
  try {
    applyMigrations(database);
    const audit = auditRecoverySqlite(database);
    const store = new DynamicTaskStore(audit.db);
    assert.deepEqual(store.listManagedCommandCandidates(), []);
    audit.assertIndex('idx_dynamic_managed_candidates');
    store.getAll();
    assert.throws(() => audit.assertIndex('idx_dynamic_managed_candidates'), /full table scan/);
  } finally {
    database.close();
  }
});
