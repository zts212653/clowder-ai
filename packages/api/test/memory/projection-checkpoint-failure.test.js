import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectionCheckpoints } from '../../dist/domains/memory/projection-checkpoints.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const entity = {
  entityId: 'person:fixture',
  type: 'person',
  canonicalName: 'Fixture',
  aliases: ['aliasX'],
  provenance: [{ source: 'fixture' }],
  updatedAt: '2026-01-01',
};

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-failure-'));
  const path = join(root, 'evidence.sqlite');
  const store = new SqliteEvidenceStore(path);
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.upsert([{ anchor: 'd', kind: 'feature', status: 'active', title: 'Document', updatedAt: '2026-01-01' }]);
  const db = store.getDb();
  const insert = db.prepare(
    "INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES('d',?,'aliasX','fixture')",
  );
  db.transaction(() => {
    for (let i = 0; i < 300; i++) insert.run(`p-${i}`);
  })();
  return { store, db, path };
}

test('checkpoint failure before publication preserves source truth and restores the connection', async (t) => {
  const { store, db } = await fixture(t);
  db.pragma('wal_autocheckpoint=37');
  const before = db.prepare('SELECT revision FROM memory_source_revision').get().revision;
  const failure = new Error('checkpoint maintenance failed');
  const injected = t.mock.method(ProjectionCheckpoints.prototype, 'afterBatch', async () => {
    throw failure;
  });
  try {
    await assert.rejects(store.upsertEntities([entity]), (error) => error === failure);
  } finally {
    injected.mock.restore();
  }
  assert.equal(await store.getEntity(entity.entityId), null);
  assert.equal(db.prepare('SELECT revision FROM memory_source_revision').get().revision, before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mention_rows').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mention_generations').get().n, 0);
  assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 37);
  await store.upsertEntities([entity]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mentions').get().n, 300);
});

test('maintenance failure after commit leaves approval and a recoverable publication receipt', async (t) => {
  const { store, db, path } = await fixture(t);
  db.pragma('wal_autocheckpoint=37');
  let published = false;
  let failed = false;
  const projection = channel('cat-cafe.entity-mention-projection');
  const onStage = (event) => {
    if (event.phase === 'published') published = true;
  };
  const drain = ProjectionCheckpoints.prototype.drain;
  const injected = t.mock.method(ProjectionCheckpoints.prototype, 'drain', async function () {
    if (published && !failed) {
      failed = true;
      throw new Error('post-commit checkpoint failure');
    }
    return drain.call(this);
  });
  const warnings = t.mock.method(console, 'warn', () => {});
  projection.subscribe(onStage);
  try {
    await store.upsertEntities([entity]);
  } finally {
    projection.unsubscribe(onStage);
    injected.mock.restore();
  }
  assert.ok(published && failed);
  assert.ok(warnings.mock.calls.some(({ arguments: args }) => args[0].includes('cleanup deferred')));
  assert.equal((await store.getEntity(entity.entityId)).canonicalName, 'Fixture');
  assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mentions').get().n, 300);
  assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 37);
  assert.equal(db.prepare('SELECT phase FROM entity_mention_generations').get().phase, 'published');
  db.exec('UPDATE entity_mention_generations SET owner_pid=0'); // The former owner's process has exited.
  store.close();
  const reopened = new SqliteEvidenceStore(path);
  try {
    await reopened.initialize();
    assert.equal(reopened.getDb().prepare('SELECT count(*) AS n FROM entity_mention_generations').get().n, 0);
    assert.equal(reopened.getDb().prepare('SELECT count(*) AS n FROM entity_mentions').get().n, 300);
  } finally {
    reopened.close();
  }
});

test('publication keeps its receipt until all checkpoint maintenance and setting restoration finish', async (t) => {
  const { store, db } = await fixture(t);
  db.pragma('wal_autocheckpoint=37');
  const maintenance = [];
  const checkpoints = channel('cat-cafe.entity-mention-checkpoint');
  const observe = () => {
    maintenance.push(db.prepare('SELECT count(*) AS n FROM entity_mention_generations').get().n);
  };
  checkpoints.subscribe(observe);
  try {
    await store.upsertEntities([entity]);
  } finally {
    checkpoints.unsubscribe(observe);
  }
  assert.ok(maintenance.length > 0);
  assert.ok(
    maintenance.every((receipts) => receipts === 1),
    'maintenance must finish before receipt deletion',
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mention_generations').get().n, 0);

  const pragma = db.pragma.bind(db);
  let attempts = 0;
  t.mock.method(db, 'pragma', (sql, ...args) => {
    if (sql === 'wal_autocheckpoint = 37' && ++attempts === 1) {
      throw new Error('checkpoint setting restoration failed');
    }
    return pragma(sql, ...args);
  });
  t.mock.method(console, 'warn', () => {});
  await store.upsertEntities([{ ...entity, canonicalName: 'Changed' }]);
  assert.equal(attempts, 2, 'the outer finalizer makes one bounded restoration attempt');
  assert.equal(pragma('wal_autocheckpoint', { simple: true }), 37);
  assert.equal((await store.getEntity(entity.entityId)).canonicalName, 'Changed');
  assert.equal(db.prepare('SELECT phase FROM entity_mention_generations').get()?.phase, 'published');
  await store.upsertEntities([{ ...entity, canonicalName: 'Next' }]);
  assert.equal((await store.getEntity(entity.entityId)).canonicalName, 'Next');
  assert.equal(pragma('wal_autocheckpoint', { simple: true }), 37);
});

test('persistent pragma restore failure keeps committed truth and rejects the next publisher until reopen', async (t) => {
  const { store, db, path } = await fixture(t);
  db.pragma('wal_autocheckpoint=37');
  const pragma = db.pragma.bind(db);
  let attempts = 0;
  t.mock.method(db, 'pragma', (sql, ...args) => {
    if (sql === 'wal_autocheckpoint = 37') {
      attempts++;
      throw new Error('persistent restoration failure');
    }
    return pragma(sql, ...args);
  });
  t.mock.method(console, 'warn', () => {});
  await store.upsertEntities([entity]);
  assert.equal(attempts, 2, 'persistent failure must not start an unbounded retry');
  assert.equal(db.open, true);
  assert.equal((await store.getEntity(entity.entityId)).canonicalName, 'Fixture');
  assert.equal(db.prepare('SELECT phase FROM entity_mention_generations').get()?.phase, 'published');
  const revision = db.prepare('SELECT revision FROM memory_source_revision').get().revision;
  await assert.rejects(store.upsertEntities([{ ...entity, canonicalName: 'Next' }]), /already owns/);
  assert.equal(attempts, 2);
  assert.equal(db.prepare('SELECT revision FROM memory_source_revision').get().revision, revision);
  assert.equal((await store.getEntity(entity.entityId)).canonicalName, 'Fixture');
  assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mentions').get().n, 300);
  store.close();
  const reopened = new SqliteEvidenceStore(path);
  try {
    await reopened.initialize();
    await reopened.upsertEntities([{ ...entity, canonicalName: 'Next' }]);
    assert.equal((await reopened.getEntity(entity.entityId)).canonicalName, 'Next');
    assert.equal(reopened.getDb().pragma('wal_autocheckpoint', { simple: true }), 1000);
  } finally {
    reopened.close();
  }
});
