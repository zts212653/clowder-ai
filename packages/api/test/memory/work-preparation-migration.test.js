import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { MemoryCueEpisodeStore } from '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { installWorkPreparationSchema } from '../../dist/domains/memory/cue/preparation/preparation-schema.js';
import { admitThreadOverviewCueFamily } from '../../dist/domains/memory/curation/thread-cue-schema-migration.js';
import { admitMatterCueFamily } from '../../dist/domains/memory/matters/matter-cue-schema.js';
import { installV43CueLedgerSchemaFixture } from '../helpers/v43-memory-cue-ledger-fixture.js';

test('preparation migration preserves occupied push/Matter receipts and all append-only guards', () => {
  const db = new Database(':memory:');
  try {
    installV43CueLedgerSchemaFixture(db);
    admitThreadOverviewCueFamily(db);
    admitMatterCueFamily(db);
    const episodes = new MemoryCueEpisodeStore(db);
    episodes.appendMatterRead({
      scope: { ownerUserId: 'owner', threadId: 'thread', invocationId: 'inv' },
      consumerCatId: 'codex61-sol',
      details: { matterId: 'matter', pageRevision: 1, entries: [{ entryId: 'entry', sourceRevision: 'original-r1' }] },
    });
    const before = db.prepare('SELECT * FROM memory_cue_events ORDER BY rowid').all();
    db.transaction(() => installWorkPreparationSchema(db)).immediate();
    assert.deepEqual(db.prepare('SELECT * FROM memory_cue_events ORDER BY rowid').all(), before);
    db.transaction(() => installWorkPreparationSchema(db)).immediate();
    assert.deepEqual(db.prepare('SELECT * FROM memory_cue_events ORDER BY rowid').all(), before);
    assert.throws(() => db.prepare("UPDATE memory_cue_events SET source_revision='replacement'").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM memory_cue_events').run(), /append-only/);
    assert.throws(
      () =>
        db
          .prepare(`INSERT INTO memory_cue_events SELECT 'forged','forged',cue_id,opportunity_id,
      owner_user_id,thread_id,invocation_id,consumer_cat_id,resolver_family,source_anchor,source_revision,
      axis,'applied',invalidation_reason,catalog_version,resolver_version,occurred_at,created_at,read_origin,read_details_json
      FROM memory_cue_events LIMIT 1`)
          .run(),
      /CHECK/,
    );
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_cue_matter_entries_shape'").get());
  } finally {
    db.close();
  }
});
