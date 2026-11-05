import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations, SCHEMA_V5, SCHEMA_V8_DYNAMIC_TASKS } from '../../src/domains/memory/schema.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { installV43CueLedgerSchemaFixture } from '../helpers/v43-memory-cue-ledger-fixture.js';

test('V46 preserves existing execution rows and rolls back its private column if the version commit fails', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_V5);
  db.exec(SCHEMA_V8_DYNAMIC_TASKS);
  installV43CueLedgerSchemaFixture(db);
  db.exec(`ALTER TABLE dynamic_task_defs ADD COLUMN entrusted_work_reevaluation_json TEXT;
    ALTER TABLE dynamic_task_defs ADD COLUMN owner_auth_provenance TEXT;
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version VALUES (45, '2026-09-19');`);
  db.prepare(`INSERT INTO dynamic_task_defs
    (id, template_id, trigger_json, params_json, display_json, enabled, created_by, created_at)
    VALUES ('existing', 'reminder', '{"type":"once","fireAt":42}', '{"message":"retained"}', '{"label":"Legacy","category":"system"}', 1, 'codex-sol', '2026-09-19')`).run();
  const before = db.prepare('SELECT * FROM dynamic_task_defs').all();
  db.exec(
    "CREATE TRIGGER reject_v46 BEFORE INSERT ON schema_version WHEN NEW.version = 46 BEGIN SELECT RAISE(ABORT, 'injected V46 failure'); END",
  );
  assert.throws(() => applyMigrations(db), /injected V46 failure/);
  assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs').all(), before);
  db.exec('DROP TRIGGER reject_v46');
  applyMigrations(db);
  applyMigrations(db);
  const after = db
    .prepare('SELECT * FROM dynamic_task_defs')
    .all()
    .map(
      ({
        development_return_json,
        reviewed_development_return_json,
        successor_development_return_json,
        parent_bound_development_return_json,
        tool_execution_policy_json,
        ...row
      }) => {
        assert.equal(development_return_json, null);
        assert.equal(reviewed_development_return_json, null);
        assert.equal(successor_development_return_json, null);
        assert.equal(parent_bound_development_return_json, null);
        assert.equal(tool_execution_policy_json, null);
        return row;
      },
    );
  assert.deepEqual(after, before);
  const store = new DynamicTaskStore(db);
  assert.equal(store.getPrivateExecutionReturn('existing'), null);
  assert.deepEqual(store.getById('existing').params, { message: 'retained' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 46').get().n, 1);
  db.close();
});

test('V47 storage fence and schema version commit atomically without rewriting legacy rows', () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  db.exec(
    'DROP TRIGGER parent_bound_development_return_no_delete; ALTER TABLE dynamic_task_defs DROP COLUMN parent_bound_development_return_json; DROP TRIGGER successor_development_return_no_delete; ALTER TABLE dynamic_task_defs DROP COLUMN successor_development_return_json; DROP TRIGGER reviewed_development_return_no_delete; ALTER TABLE dynamic_task_defs DROP COLUMN reviewed_development_return_json; DELETE FROM schema_version WHERE version >= 47',
  );
  db.exec(
    "CREATE TRIGGER reject_v47 BEFORE INSERT ON schema_version WHEN NEW.version = 47 BEGIN SELECT RAISE(ABORT, 'injected V47 failure'); END",
  );
  assert.throws(() => applyMigrations(db), /injected V47 failure/);
  assert.equal(
    db
      .prepare('PRAGMA table_info(dynamic_task_defs)')
      .all()
      .some((column) => column.name === 'reviewed_development_return_json'),
    false,
  );
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'reviewed_development_return_no_delete'").get(),
    undefined,
  );
  db.exec('DROP TRIGGER reject_v47');
  applyMigrations(db);
  applyMigrations(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 47').get().n, 1);
  db.close();
});

test('V59 reserves a storage fence that V52 readers cannot project as executable return authority', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    const columns = db.prepare('PRAGMA table_info(dynamic_task_defs)').all() as { name: string }[];
    assert.ok(columns.some((column) => column.name === 'successor_development_return_json'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 59').get().n, 1);
    db.prepare(`INSERT INTO dynamic_task_defs
      (id, template_id, trigger_json, params_json, display_json, enabled, created_by, created_at,
        successor_development_return_json)
      VALUES ('successor', 'development-terminal-return', '{"type":"once","fireAt":42}', '{}',
        '{"label":"Successor","category":"system"}', 0, 'codex-astra', '2026-10-06', '{}')`).run();
    const row = db
      .prepare(
        'SELECT enabled, development_return_json, reviewed_development_return_json, successor_development_return_json FROM dynamic_task_defs WHERE id = ?',
      )
      .get('successor') as Record<string, unknown>;
    assert.equal(row.enabled, 0);
    assert.equal(row.development_return_json, null);
    assert.equal(row.reviewed_development_return_json, null);
    assert.equal(row.successor_development_return_json, '{}');
    assert.throws(() => db.exec("DELETE FROM dynamic_task_defs WHERE id = 'successor'"), /typed owner transition/);
  } finally {
    db.close();
  }
});

test('V59 storage fence and version marker roll back atomically, then reenter idempotently', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    db.exec(
      'DROP TRIGGER parent_bound_development_return_no_delete; ALTER TABLE dynamic_task_defs DROP COLUMN parent_bound_development_return_json; DROP TRIGGER successor_development_return_no_delete; ALTER TABLE dynamic_task_defs DROP COLUMN successor_development_return_json; DELETE FROM schema_version WHERE version >= 59',
    );
    db.exec(
      "CREATE TRIGGER reject_v59 BEFORE INSERT ON schema_version WHEN NEW.version = 59 BEGIN SELECT RAISE(ABORT, 'injected V59 failure'); END",
    );
    assert.throws(() => applyMigrations(db), /injected V59 failure/);
    const columns = db.prepare('PRAGMA table_info(dynamic_task_defs)').all() as { name: string }[];
    assert.equal(
      columns.some((column) => column.name === 'successor_development_return_json'),
      false,
    );
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'successor_development_return_no_delete'").get(),
      undefined,
    );
    db.exec('DROP TRIGGER reject_v59');
    applyMigrations(db);
    applyMigrations(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 59').get().n, 1);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'successor_development_return_no_delete'").get());
  } finally {
    db.close();
  }
});

test('V59 repairs the successor fence when reverted V53-V57 markers outlive their schema', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    db.exec(
      'DROP TRIGGER parent_bound_development_return_no_delete; ALTER TABLE dynamic_task_defs DROP COLUMN parent_bound_development_return_json; DROP TRIGGER successor_development_return_no_delete; ALTER TABLE dynamic_task_defs DROP COLUMN successor_development_return_json; DELETE FROM schema_version WHERE version >= 53',
    );
    for (const version of [53, 54, 55, 56, 57]) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        version,
        '2026-10-06T11:23:00.000Z',
      );
    }

    applyMigrations(db);

    const columns = db.prepare('PRAGMA table_info(dynamic_task_defs)').all() as { name: string }[];
    assert.ok(columns.some((column) => column.name === 'successor_development_return_json'));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'successor_development_return_no_delete'").get());
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 59').get().n, 1);

    const store = new DynamicTaskStore(db);
    store.upsert({
      id: 'reminder-after-revert',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: 42 },
      params: {},
      display: { label: 'Reminder', category: 'system' },
      deliveryThreadId: 'thread-owner',
      enabled: true,
      createdBy: 'codex-sol',
      createdAt: '2026-10-06T11:24:00.000Z',
    });
    assert.equal(store.getPrivateExecutionReturn('reminder-after-revert'), null);
    assert.deepEqual(store.findPrivateExecutionReturns('thread-owner'), []);
    store.setEnabled('reminder-after-revert', false);
    assert.equal(store.getById('reminder-after-revert')?.enabled, false);
  } finally {
    db.close();
  }
});

test('V59 restores a missing successor trigger even when its version marker already exists', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    db.exec('DROP TRIGGER successor_development_return_no_delete');

    applyMigrations(db);

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 59').get().n, 1);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'successor_development_return_no_delete'").get());
  } finally {
    db.close();
  }
});

test('V67 fences parent-bound returns from every earlier executable projection', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    const columns = db.prepare('PRAGMA table_info(dynamic_task_defs)').all() as { name: string }[];
    assert.ok(columns.some((column) => column.name === 'parent_bound_development_return_json'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 67').get().n, 1);
    db.prepare(`INSERT INTO dynamic_task_defs
      (id, template_id, trigger_json, params_json, display_json, enabled, created_by, created_at,
        parent_bound_development_return_json)
      VALUES ('parent-bound', 'development-terminal-return', '{"type":"once","fireAt":42}', '{}',
        '{"label":"Parent bound","category":"system"}', 0, 'codex-sol', '2026-10-13', '{}')`).run();
    const legacyProjection = db
      .prepare(`SELECT id FROM dynamic_task_defs WHERE id = 'parent-bound' AND
        (enabled = 1 OR reviewed_development_return_json IS NOT NULL
          OR successor_development_return_json IS NOT NULL)`)
      .get();
    assert.equal(legacyProjection, undefined);
    assert.throws(() => db.exec("DELETE FROM dynamic_task_defs WHERE id = 'parent-bound'"), /typed owner transition/);
  } finally {
    db.close();
  }
});

test('V67 storage fence and version marker roll back atomically, then reenter idempotently', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    db.exec(
      'DROP TRIGGER parent_bound_development_return_no_delete; ALTER TABLE dynamic_task_defs DROP COLUMN parent_bound_development_return_json; DELETE FROM schema_version WHERE version >= 67',
    );
    db.exec(
      "CREATE TRIGGER reject_v67 BEFORE INSERT ON schema_version WHEN NEW.version = 67 BEGIN SELECT RAISE(ABORT, 'injected V67 failure'); END",
    );
    assert.throws(() => applyMigrations(db), /injected V67 failure/);
    const columns = db.prepare('PRAGMA table_info(dynamic_task_defs)').all() as { name: string }[];
    assert.equal(
      columns.some((column) => column.name === 'parent_bound_development_return_json'),
      false,
    );
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'parent_bound_development_return_no_delete'").get(),
      undefined,
    );
    db.exec('DROP TRIGGER reject_v67');
    applyMigrations(db);
    applyMigrations(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 67').get().n, 1);
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'parent_bound_development_return_no_delete'").get(),
    );
  } finally {
    db.close();
  }
});

for (const missingTrigger of [false, true]) {
  test(`V47 reentry preserves existing rows and storage fences with missingTrigger=${missingTrigger}`, () => {
    const db = new Database(':memory:');
    try {
      applyMigrations(db);
      db.prepare(`INSERT INTO dynamic_task_defs
        (id, template_id, trigger_json, params_json, display_json, enabled, created_by, created_at,
          reviewed_development_return_json)
        VALUES (?, ?, '{"type":"once","fireAt":42}', '{}', '{"label":"Retained","category":"system"}',
          ?, 'codex-astra', '2026-09-20', ?)`).run(
        'reviewed',
        'development-terminal-return',
        0,
        '{"status":"waiting","evidence":"unchanged"}',
      );
      db.prepare(`INSERT INTO dynamic_task_defs
        (id, template_id, trigger_json, params_json, display_json, enabled, created_by, created_at)
        VALUES ('legacy', 'reminder', '{"type":"once","fireAt":42}', '{"message":"retained"}',
          '{"label":"Legacy","category":"system"}', 1, 'codex-sol', '2026-09-19')`).run();
      const before = db.prepare('SELECT * FROM dynamic_task_defs ORDER BY id').all();
      const table = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dynamic_task_defs'")
        .get();
      db.exec('DELETE FROM schema_version WHERE version >= 47');
      if (missingTrigger) db.exec('DROP TRIGGER reviewed_development_return_no_delete');

      applyMigrations(db);
      applyMigrations(db);

      assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs ORDER BY id').all(), before);
      assert.deepEqual(
        db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dynamic_task_defs'").get(),
        table,
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 47').get().n, 1);
      assert.throws(
        () => db.exec("UPDATE dynamic_task_defs SET enabled = 1 WHERE id = 'reviewed'"),
        /CHECK constraint failed/,
      );
      assert.throws(
        () => db.exec("UPDATE dynamic_task_defs SET template_id = 'reminder' WHERE id = 'reviewed'"),
        /CHECK constraint failed/,
      );
      assert.throws(
        () => db.exec("UPDATE dynamic_task_defs SET development_return_json = '{}' WHERE id = 'reviewed'"),
        /CHECK constraint failed/,
      );
      assert.throws(() => db.exec("DELETE FROM dynamic_task_defs WHERE id = 'reviewed'"), /typed owner transition/);
    } finally {
      db.close();
    }
  });
}

test('V47 reentry rolls back a restored trigger if the version marker fails, then retries', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    db.exec('DELETE FROM schema_version WHERE version >= 47; DROP TRIGGER reviewed_development_return_no_delete');
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dynamic_task_defs'").get();
    db.exec(
      "CREATE TRIGGER reject_v47 BEFORE INSERT ON schema_version WHEN NEW.version = 47 BEGIN SELECT RAISE(ABORT, 'injected V47 failure'); END",
    );
    assert.throws(() => applyMigrations(db), /injected V47 failure/);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'reviewed_development_return_no_delete'").get(),
      undefined,
    );
    assert.deepEqual(
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dynamic_task_defs'").get(),
      table,
    );
    db.exec('DROP TRIGGER reject_v47');
    applyMigrations(db);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'reviewed_development_return_no_delete'").get());
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 47').get().n, 1);
  } finally {
    db.close();
  }
});
