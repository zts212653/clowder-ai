import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

const columns = [
  'event_id',
  'idempotency_key',
  'cue_id',
  'opportunity_id',
  'owner_user_id',
  'thread_id',
  'invocation_id',
  'resolver_family',
  'source_anchor',
  'source_revision',
  'axis',
  'consumption_outcome',
  'invalidation_reason',
  'catalog_version',
  'resolver_version',
  'occurred_at',
  'created_at',
];

function insert(db, overrides = {}) {
  const event = {
    event_id: 'event-1',
    idempotency_key: 'key-1',
    cue_id: 'cue-1',
    opportunity_id: 'opportunity-1',
    owner_user_id: 'owner-1',
    thread_id: 'thread-1',
    invocation_id: 'invocation-1',
    resolver_family: 'person_entity',
    source_anchor: 'person:alden',
    source_revision: 'revision-1',
    axis: 'consumption',
    consumption_outcome: 'presented',
    invalidation_reason: null,
    catalog_version: 1,
    resolver_version: 1,
    occurred_at: 1_000,
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO memory_cue_events (${columns.join(', ')})
    VALUES (${columns.map((column) => `@${column}`).join(', ')})
  `).run(event);
}

describe('V37 memory cue event ledger migration', () => {
  it('creates only the content-free append-only coordinate ledger', async () => {
    const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    const db = new Database(':memory:');
    applyMigrations(db);

    assert.equal(CURRENT_SCHEMA_VERSION, 39);
    assert.deepEqual(
      db
        .prepare('PRAGMA table_info(memory_cue_events)')
        .all()
        .map((column) => column.name),
      columns,
    );
    for (const forbidden of [
      'content',
      'title',
      'summary',
      'why_now',
      'query_text',
      'payload_json',
      'rationale',
      'score',
      'expires_at',
    ]) {
      assert.equal(columns.includes(forbidden), false);
    }
    assert.deepEqual(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'memory_cue_events'")
        .all()
        .map((row) => row.name)
        .sort(),
      ['memory_cue_events_no_delete', 'memory_cue_events_no_update'],
    );
  });

  it('enforces consumption and invalidation as separate enum axes', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const db = new Database(':memory:');
    applyMigrations(db);

    insert(db);
    insert(db, {
      event_id: 'event-2',
      idempotency_key: 'key-2',
      axis: 'invalidation',
      consumption_outcome: null,
      invalidation_reason: 'source_forgotten',
    });
    assert.throws(
      () =>
        insert(db, {
          event_id: 'event-3',
          idempotency_key: 'key-3',
          axis: 'consumption',
          consumption_outcome: 'presented',
          invalidation_reason: 'expired',
        }),
      /CHECK constraint/i,
    );
    assert.throws(
      () =>
        insert(db, {
          event_id: 'event-4',
          idempotency_key: 'key-4',
          axis: 'invalidation',
          consumption_outcome: null,
          invalidation_reason: 'corrected',
        }),
      /CHECK constraint/i,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_cue_events').get().count, 2);
  });

  it('rejects update/delete and retains events without a TTL cleanup column', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const db = new Database(':memory:');
    applyMigrations(db);
    insert(db);

    assert.throws(() => db.prepare("UPDATE memory_cue_events SET source_revision = 'rewrite'").run(), /append-only/i);
    assert.throws(() => db.prepare('DELETE FROM memory_cue_events').run(), /append-only/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_cue_events').get().count, 1);
  });
});
