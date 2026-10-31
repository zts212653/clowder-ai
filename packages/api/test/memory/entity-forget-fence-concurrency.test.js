import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

const workerSource = `
  const { workerData, parentPort } = require('node:worker_threads');
  const Database = require(workerData.module);
  const flags = new Int32Array(workerData.flags);
  let db;
  try {
    db = new Database(workerData.path);
    db.pragma('busy_timeout = 0');
    Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);
    if (Atomics.wait(flags, 0, 1, 5000) === 'timed-out') throw new Error('installer did not release worker');
    const info = db.prepare(workerData.sql).run(...workerData.values);
    Atomics.store(flags, 1, info.changes === 1 ? 1 : 0);
  } catch (error) {
    Atomics.store(flags, 1, error.code === 'SQLITE_BUSY' ? 2 : error.code === 'SQLITE_CONSTRAINT_TRIGGER' ? 3 : 4);
  } finally {
    if (db) db.close();
    Atomics.store(flags, 0, 3); Atomics.notify(flags, 0); parentPort.close();
  }
`;

test('keeps Entity cleanup and forget-trigger replacement atomic against a legacy writer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'f321-entity-fence-race-'));
  const dbPath = join(directory, 'memory.sqlite');
  const bootstrap = new Database(dbPath);
  applyMigrations(bootstrap);
  bootstrap
    .prepare(
      `INSERT INTO entity_memory_forget_tombstones (entity_id, owner_user_id, forgotten_at)
       VALUES (?, ?, ?)`,
    )
    .run('concept:forgotten-race', 'owner-a', '2026-10-06T00:00:00.000Z');
  bootstrap.close();

  const flags = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: {
      module: createRequire(import.meta.url).resolve('better-sqlite3'),
      path: dbPath,
      flags: flags.buffer,
      sql: `INSERT INTO entity_registry
        (entity_id, entity_type, canonical_name, provenance_json, stance,
         visibility_scope, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [
        'concept:forgotten-race',
        'concept',
        'Legacy resurrection',
        '[]',
        'endorsed',
        'workspace',
        'active',
        '2026-10-06T00:00:00.000Z',
        '2026-10-06T00:00:00.000Z',
      ],
    },
  });
  assert.notEqual(Atomics.wait(flags, 0, 0, 5000), 'timed-out', 'legacy worker must open before reinstall');
  assert.equal(Atomics.load(flags, 0), 1);

  let synchronized = false;
  const installer = new Database(dbPath, {
    verbose: (sql) => {
      if (!/^\s*CREATE TRIGGER entity_registry_forget_no_insert\b/.test(sql)) return;
      synchronized = true;
      Atomics.store(flags, 0, 2);
      Atomics.notify(flags, 0);
      assert.notEqual(
        Atomics.wait(flags, 0, 2, 5000),
        'timed-out',
        'legacy writer must finish while trigger replacement is paused',
      );
    },
  });
  try {
    applyMigrations(installer);
    assert.equal(synchronized, true, 'SQLite trace must observe the real CREATE after DROP');
    assert.notEqual(Atomics.load(flags, 1), 4, 'legacy write must reach a known SQLite outcome');
    assert.equal(
      installer.prepare('SELECT 1 FROM entity_registry WHERE entity_id = ?').get('concept:forgotten-race'),
      undefined,
    );
  } finally {
    installer.close();
    await worker.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
});
