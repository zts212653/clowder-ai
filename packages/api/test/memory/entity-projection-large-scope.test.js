import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EntityRegistryStore } from '../../dist/domains/memory/EntityRegistry.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const entity = {
  entityId: 'concept:large',
  type: 'concept',
  canonicalName: 'largeword',
  aliases: [],
  provenance: [{ source: 'fixture' }],
  updatedAt: '2026-01-01',
};
test(
  'a full document publication exceeds the SQLite variable limit without truncating its scope',
  { timeout: 30000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mention-large-scope-'));
    const store = new SqliteEvidenceStore(join(dir, 'evidence.sqlite'));
    await store.initialize();
    t.after(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const db = store.getDb();
    const anchors = Array.from({ length: 33000 }, (_, i) => `doc:${i}`);
    const insert = db.prepare(
      "INSERT INTO evidence_docs(anchor,kind,status,title,updated_at) VALUES(?,'feature','active','largeword','2026-01-01')",
    );
    db.transaction(() => {
      for (const anchor of anchors) insert.run(anchor);
    })();
    new EntityRegistryStore(db).upsert([entity], { source: 'fixture' });
    await store.refreshEntityMentions(anchors);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mentions').get().n, anchors.length);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mention_doc_heads').get().n, anchors.length);
  },
);

test('entity refresh selectors also accept a large ID scope with unchanged matching semantics', async (t) => {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  await store.upsert([
    { anchor: 'doc', kind: 'feature', status: 'active', title: 'largeword', updatedAt: '2026-01-01' },
  ]);
  const registry = new EntityRegistryStore(store.getDb());
  registry.upsert([entity], { source: 'fixture' });
  registry.refreshMentionsForEntities([entity.entityId, ...Array.from({ length: 33000 }, (_, i) => `missing:${i}`)]);
  assert.deepEqual(store.getDb().prepare('SELECT entity_id, doc_anchor FROM entity_mentions').all(), [
    { entity_id: entity.entityId, doc_anchor: 'doc' },
  ]);
});
