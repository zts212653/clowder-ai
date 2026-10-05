import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { SqliteEvidenceStore } from '../src/domains/memory/SqliteEvidenceStore.js';
import { evidenceRoutes } from '../src/routes/evidence.js';

test('document clock is MAX(updated_at), independent of a legacy/manual rebuild stamp', async () => {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  await store.upsert([
    { anchor: 'old', kind: 'feature', status: 'active', title: '旧文档', updatedAt: '2026-09-01T00:00:00Z' },
    { anchor: 'new', kind: 'feature', status: 'active', title: '新文档', updatedAt: '2026-10-01T00:00:00Z' },
  ]);
  store
    .getDb()
    .prepare("INSERT INTO embedding_meta (key,value) VALUES ('last_rebuild_at','2026-08-01T00:00:00Z')")
    .run();
  const app = Fastify();
  await app.register(evidenceRoutes, { evidenceStore: store });
  try {
    const response = await app.inject({ url: '/api/evidence/status' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().healthy, true);
    assert.equal(response.json().last_document_updated_at, '2026-10-01T00:00:00Z');
    assert.equal(response.json().last_rebuild_at, '2026-08-01T00:00:00Z');
  } finally {
    await app.close();
    store.getDb().close();
  }
});
