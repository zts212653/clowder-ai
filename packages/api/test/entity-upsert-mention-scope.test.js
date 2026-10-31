import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';

const entity = (id, aliases = [], overrides = {}) => ({
  entityId: `concept:${id}`,
  type: 'concept',
  canonicalName: id,
  aliases,
  provenance: [{ source: 'test', anchor: id }],
  status: 'active',
  updatedAt: '2026-09-17T00:00:00.000Z',
  ...overrides,
});

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mention-scope-'));
  const store = new SqliteEvidenceStore(join(dir, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await store.upsert([
    {
      anchor: 'doc:mention-scope',
      kind: 'feature',
      status: 'active',
      title: 'Entity approval fixture',
      summary: '稳定词、旧别名、新别名、新实体、另一个实体。',
      updatedAt: '2026-09-17T00:00:00.000Z',
    },
  ]);
  const db = store.getDb();
  db.prepare(`INSERT INTO evidence_passages
    (doc_anchor, passage_id, content, speaker, position, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    'doc:mention-scope',
    'msg:fixture',
    '稳定词、旧别名、新别名、新实体、另一个实体。',
    'user',
    0,
    '2026-09-17T00:00:00.000Z',
  );
  await store.upsertEntities([entity('stable', ['稳定词']), entity('changing', ['旧别名'])]);
  db.exec(`CREATE TEMP TABLE unrelated_deletes(generation INTEGER);
    CREATE TEMP TRIGGER observe_unrelated_delete AFTER DELETE ON entity_mention_rows
    WHEN OLD.entity_id = 'concept:stable' BEGIN INSERT INTO unrelated_deletes VALUES(OLD.generation); END;`);
  return { store, db };
}

function heads(db) {
  return new Map(
    db
      .prepare('SELECT entity_id,generation FROM entity_mention_entity_heads')
      .all()
      .map((row) => [row.entity_id, row.generation]),
  );
}
function changedIds(db, before) {
  return [...heads(db)]
    .filter(([id, generation]) => before.get(id) !== generation)
    .map(([id]) => id)
    .sort();
}

function mentions(db, id) {
  return db.prepare('SELECT * FROM entity_mentions WHERE entity_id = ? ORDER BY source, surface').all(`concept:${id}`);
}

describe('entity upserts bound mention refresh to the supplied entities', () => {
  it('ordinary proposal approval preserves unrelated rows and immediately indexes docs and passages', async (t) => {
    const { store, db } = await fixture(t);
    const stable = mentions(db, 'stable');
    const beforeHeads = heads(db);
    assert.equal(stable.length, 2);
    await store.upsertEntities([entity('new', ['新实体'])], {
      source: 'proposal-approval',
      actorId: 'user-1',
      proposalId: 'ep-new',
      conflictPolicy: 'reject-conflict',
    });
    assert.deepEqual(
      changedIds(db, beforeHeads),
      ['concept:new'],
      "approval must not publish other entities' derived rows",
    );
    assert.deepEqual(mentions(db, 'stable'), stable);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM unrelated_deletes').get().n,
      0,
      'unrelated physical rows must not be deleted and reinserted',
    );
    assert.deepEqual(
      mentions(db, 'new').map((row) => row.source),
      ['doc', 'passage'],
    );
    assert.equal((await store.resolveEntityAliases('新实体'))[0].entityId, 'concept:new');
  });

  it('refreshes every input in a batch, removes old aliases and preserves entities outside the batch', async (t) => {
    const { store, db } = await fixture(t);
    const stable = mentions(db, 'stable');
    let beforeHeads = heads(db);
    await store.upsertEntities([entity('changing', ['新别名']), entity('another', ['另一个实体'])]);
    assert.deepEqual(changedIds(db, beforeHeads), ['concept:another', 'concept:changing']);
    assert.deepEqual(mentions(db, 'stable'), stable);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM unrelated_deletes').get().n,
      0,
      'unrelated physical rows must not be deleted and reinserted',
    );
    assert.deepEqual(
      mentions(db, 'changing').map((row) => row.surface),
      ['新别名', '新别名'],
    );
    assert.equal(mentions(db, 'another').length, 2);
    beforeHeads = heads(db);
    await store.upsertEntities([entity('changing')]);
    assert.deepEqual(changedIds(db, beforeHeads), ['concept:changing']);
    assert.deepEqual(mentions(db, 'changing'), []);
    assert.deepEqual(mentions(db, 'stable'), stable);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM unrelated_deletes').get().n,
      0,
      'unrelated physical rows must not be deleted and reinserted',
    );
  });

  it('rolls back registry, aliases, revisions and all batch mentions if projection fails', async (t) => {
    const { store, db } = await fixture(t);
    const snapshot = () =>
      Object.fromEntries(
        [
          'entity_registry',
          'entity_aliases',
          'entity_revision_events',
          'entity_mentions',
          'entity_mention_entity_heads',
        ].map((table) => [
          table,
          db
            .prepare(
              `SELECT * FROM ${table} ORDER BY ${table === 'entity_mentions' ? 'entity_id,doc_anchor,passage_id,surface_norm' : 'rowid'}`,
            )
            .all(),
        ]),
      );
    const before = snapshot();
    db.exec(`CREATE TEMP TRIGGER fail_new_entity BEFORE INSERT ON entity_mention_entity_heads
      WHEN NEW.entity_id = 'concept:new' BEGIN SELECT RAISE(ABORT, 'projection failure'); END;`);
    await assert.rejects(
      store.upsertEntities([entity('changing', ['新别名']), entity('new', ['新实体'])]),
      /projection failure/,
    );
    assert.deepEqual(snapshot(), before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mention_generations').get().n, 0);
    db.exec('DROP TRIGGER fail_new_entity');
    await store.upsertEntities([entity('new', ['新实体'])]);
    assert.equal(mentions(db, 'new').length, 2, 'the write queue must remain usable after rollback');
  });
});
