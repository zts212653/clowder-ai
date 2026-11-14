import assert from 'node:assert/strict';
import { it } from 'node:test';
import Database from 'better-sqlite3';
import { MemoryCueEpisodeStore } from '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { admitThreadOverviewCueFamily } from '../../dist/domains/memory/curation/thread-cue-schema-migration.js';
import { admitMatterCueFamily } from '../../dist/domains/memory/matters/matter-cue-schema.js';
import { installV43CueLedgerSchemaFixture } from '../helpers/v43-memory-cue-ledger-fixture.js';

it('upgrades an occupied legacy ledger losslessly and rejects cross-family or prose-bearing read details in SQL', () => {
  const db = new Database(':memory:');
  try {
    installV43CueLedgerSchemaFixture(db);
    admitThreadOverviewCueFamily(db);
    db.prepare(`INSERT INTO memory_cue_events VALUES (
      'legacy', 'legacy-key', 'legacy-cue', 'legacy-opportunity', 'owner', 'thread', 'invocation', 'sonnet',
      'profile', 'profile:current', 'r1', 'consumption', 'presented', NULL, 7, 1, 123, '2026-11-01T00:00:00Z'
    )`).run();
    const before = db.prepare('SELECT * FROM memory_cue_events').get();
    db.transaction(() => admitMatterCueFamily(db))();
    const after = db.prepare('SELECT * FROM memory_cue_events').get();
    assert.deepEqual(after, { ...before, read_origin: 'push', read_details_json: null });
    const store = new MemoryCueEpisodeStore(db);
    const legacy = store.listByCue('owner', 'legacy-cue')[0];
    assert.equal(legacy.readDetails, undefined);
    assert.equal(legacy.readOrigin, undefined);
    assert.equal(legacy.occurredAt, 123);
    store.appendMatterRead({
      scope: { ownerUserId: 'owner', threadId: 'thread', invocationId: 'invocation' },
      consumerCatId: 'sonnet',
      details: {
        matterId: 'matter',
        pageRevision: 1,
        entries: [{ entryId: 'entry', sourceRevision: 'sha256:source' }],
      },
    });
    const committed = db.prepare('SELECT * FROM memory_cue_events ORDER BY rowid').all();
    db.transaction(() => admitMatterCueFamily(db))();
    assert.deepEqual(db.prepare('SELECT * FROM memory_cue_events ORDER BY rowid').all(), committed);
    const sample = db.prepare("SELECT * FROM memory_cue_events WHERE resolver_family='matter' LIMIT 1").get();
    const fields = Object.keys(sample);
    const insert = db.prepare(
      `INSERT INTO memory_cue_events (${fields.join(',')}) VALUES (${fields.map((key) => '@' + key).join(',')})`,
    );
    const cases = [
      { resolver_family: 'profile' },
      { read_origin: 'push' },
      { consumption_outcome: 'applied' },
      { read_details_json: null },
      { read_details_json: JSON.stringify({ matterId: 'matter', pageRevision: 1, entries: [] }) },
      {
        read_details_json: JSON.stringify({
          matterId: 'matter',
          pageRevision: 1,
          entries: [{ entryId: 'e', sourceRevision: 'r', quote: 'forbidden text' }],
        }),
      },
      {
        read_details_json: JSON.stringify({
          matterId: 'matter',
          pageRevision: 1,
          entries: [{ entryId: 'e', sourceRevision: 'r' }],
          title: 'forbidden title',
        }),
      },
    ];
    for (const [index, change] of cases.entries()) {
      assert.throws(() =>
        insert.run({ ...sample, event_id: 'invalid-' + index, idempotency_key: 'invalid-' + index, ...change }),
      );
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_cue_events').get().n, 3);
    assert.throws(() => db.prepare("UPDATE memory_cue_events SET source_revision='new'").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM memory_cue_events').run(), /append-only/);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_memory_cue_events_cue_scope'").get());
  } finally {
    db.close();
  }
});
