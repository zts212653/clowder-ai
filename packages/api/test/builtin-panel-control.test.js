import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { GlobalControlStore } from '../dist/infrastructure/scheduler/GlobalControlStore.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scheduler_global_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      reason TEXT,
      updated_by TEXT NOT NULL DEFAULT 'system',
      updated_at TEXT NOT NULL
    );
    INSERT INTO scheduler_global_control (id, enabled, updated_by, updated_at)
      VALUES (1, 1, 'system', datetime('now'));
    CREATE TABLE scheduler_task_overrides (
      task_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('AC-H4: builtin task panel control via task override', () => {
  it('setTaskOverride pauses a builtin task', () => {
    const db = createTestDb();
    const store = new GlobalControlStore(db);

    store.setTaskOverride('review-comments-checker', false, 'user');
    const override = store.getTaskOverride('review-comments-checker');
    assert.ok(override);
    assert.equal(override.enabled, false);
    assert.equal(override.updatedBy, 'user');
  });

  it('setTaskOverride resumes a paused builtin task', () => {
    const db = createTestDb();
    const store = new GlobalControlStore(db);

    store.setTaskOverride('review-comments-checker', false, 'user');
    store.setTaskOverride('review-comments-checker', true, 'user');
    const override = store.getTaskOverride('review-comments-checker');
    assert.ok(override);
    assert.equal(override.enabled, true);
  });

  it('removeTaskOverride clears override for builtin task', () => {
    const db = createTestDb();
    const store = new GlobalControlStore(db);

    store.setTaskOverride('review-comments-checker', false, 'user');
    const removed = store.removeTaskOverride('review-comments-checker');
    assert.equal(removed, true);
    assert.equal(store.getTaskOverride('review-comments-checker'), null);
  });

  it('effectiveEnabled reflects task override for builtin tasks', () => {
    const db = createTestDb();
    const store = new GlobalControlStore(db);

    // No override → getTaskOverride returns null
    assert.equal(store.getTaskOverride('builtin-task'), null);

    // With override disabled → returns enabled=false
    store.setTaskOverride('builtin-task', false, 'user');
    const override = store.getTaskOverride('builtin-task');
    assert.equal(override?.enabled, false);
  });
});
