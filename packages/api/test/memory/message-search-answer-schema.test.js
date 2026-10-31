import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { MessageSearchAnswerPublicationStore } from '../../dist/domains/memory/MessageSearchAnswerPublicationStore.js';
import { applyMigrations, CURRENT_SCHEMA_VERSION } from '../../dist/domains/memory/schema.js';
import { fixture } from '../helpers/message-search-answer-fixture.js';

test('answer publication upgrades the existing memory database idempotently, retaining earlier user records', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    db.exec('DROP TABLE message_search_answer_publications');
    db.prepare('DELETE FROM schema_version WHERE version>=71').run();
    db.exec(
      "CREATE TABLE answer_migration_witness(body TEXT); INSERT INTO answer_migration_witness VALUES ('previous user record')",
    );
    applyMigrations(db);
    applyMigrations(db);
    assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, CURRENT_SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT body FROM answer_migration_witness').get().body, 'previous user record');
    const columns = db
      .prepare('PRAGMA table_info(message_search_answer_publications)')
      .all()
      .map((row) => row.name);
    assert.ok(columns.includes('response_json'));
    assert.ok(!columns.some((column) => /ttl|expires/i.test(column)));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_search_answer_invocation'").get());
  } finally {
    db.close();
  }
});

test('V71 prepared response and reserved coordinates survive the V72 recovery-only migration', async () => {
  const f = fixture();
  const db = new Database(':memory:');
  try {
    const saved = await f.service.prepare(f.request);
    const { recovery_order: _recovery, ...before } = f.store.get(saved.publicationRef);
    before.bound_message_id = 'reserved-original-message';
    before.block_id = 'reserved-original-block';
    applyMigrations(db);
    db.exec('DROP TABLE message_search_answer_publications');
    db.prepare('DELETE FROM schema_version WHERE version>=71').run();
    db.exec(readFileSync(new URL('../fixtures/message-search-answer-v71.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO schema_version VALUES (?,?)').run(71, 'original');
    const columns = Object.keys(before);
    db.prepare(
      `INSERT INTO message_search_answer_publications(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    ).run(...Object.values(before));
    applyMigrations(db);
    applyMigrations(db);
    const store = new MessageSearchAnswerPublicationStore(db);
    const { recovery_order, ...after } = store.get(saved.publicationRef);
    assert.deepEqual(after, before, 'migration does not rewrite the sole response, provenance or reserved binding');
    assert.equal(recovery_order, 0, 'reserved coordinates are still eligible; they do not prove reconciliation');
    assert.deepEqual(store.response(store.get(saved.publicationRef)), saved.response);
    assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, CURRENT_SCHEMA_VERSION);
  } finally {
    f.db.close();
    db.close();
  }
});
