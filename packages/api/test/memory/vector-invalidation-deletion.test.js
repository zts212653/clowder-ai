import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

for (const route of ['anchor', 'prefix']) {
  test(`cold/off ${route} removal invalidates exact document/passages without deleting unrelated vectors`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'off-deletion-'));
    const path = join(root, 'db.sqlite');
    let store = new SqliteEvidenceStore(path);
    await store.initialize();
    t.after(() => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await store.upsert(
      ['F001', 'F002'].map((anchor) => ({
        anchor,
        kind: 'feature',
        status: 'active',
        title: anchor,
        sourcePath: `${anchor}/source.md`,
        updatedAt: '2026-01-01',
      })),
    );
    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 4);
    ensurePassageVectorTable(db, 4);
    for (const anchor of ['F001', 'F002']) {
      db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)').run(
        anchor,
        'md-0',
        anchor,
        '2026-01-01T00:00:00.000Z',
      );
      new VectorStore(db, 4).upsert(anchor, new Float32Array([1, 0, 0, 0]));
      new PassageVectorStore(db, 4).upsert(passageVectorKey(anchor, 'md-0'), new Float32Array([1, 0, 0, 0]));
    }
    store.close();
    store = new SqliteEvidenceStore(path);
    await store.initialize();
    assert.equal(store.getDb().prepare("SELECT 1 FROM pragma_module_list WHERE name='vec0'").get(), undefined);
    if (route === 'anchor') await store.deleteByAnchor('F001');
    else assert.equal(store.removeBySourcePrefix('F001/'), 1);
    assert.equal(new VectorStore(store.getDb(), 4).count(), 1);
    assert.equal(new PassageVectorStore(store.getDb(), 4).count(), 1);
    assert.equal(store.getDb().prepare('SELECT 1 FROM evidence_vectors WHERE anchor=?').get('F001'), undefined);
    assert.ok(store.getDb().prepare('SELECT 1 FROM evidence_vectors WHERE anchor=?').get('F002'));
  });
}
