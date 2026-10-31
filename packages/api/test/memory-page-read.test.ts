import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { SqliteEvidenceStore } from '../src/domains/memory/SqliteEvidenceStore.js';
import { memoryPageReadRoutes } from '../src/routes/memory-page-read.js';

async function setup() {
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  await evidence.upsert([
    {
      anchor: 'public-feature',
      kind: 'feature',
      status: 'active',
      title: '真实文档',
      updatedAt: '2026-09-01',
      authority: 'constitutional',
    },
  ]);
  const db = evidence.getDb();
  const manifest = {
    id: 'project:public',
    kind: 'project',
    displayName: '公共资料库',
    sensitivity: 'public',
    root: '/secret/path',
    status: 'active',
  };
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session'] as string | undefined;
  });
  await app.register(memoryPageReadRoutes, {
    ownerUserId: 'owner',
    catalog: { list: () => [manifest] },
    stores: new Map([[manifest.id, evidence]]),
    evidenceDb: db,
    markerQueue: {
      list: async () => [
        { id: 'm1', content: '教训内容', source: 'private raw ref', status: 'approved', createdAt: '2026-10-01' },
        {
          id: 'm2',
          content: '外人私有内容',
          source: 'other',
          status: 'captured',
          createdAt: '2026-10-01',
          sourceCollectionId: 'private:other',
        },
      ],
    },
  });
  await app.ready();
  return { app, db };
}
test('owner read works outside loopback; unauthenticated and other sessions fail closed for all projections', async () => {
  const { app } = await setup();
  try {
    for (const url of [
      '/api/memory/catalog',
      '/api/memory/library-feed',
      '/api/memory/maintenance',
      '/api/memory/brakes/e1/source',
    ]) {
      assert.equal((await app.inject({ url, remoteAddress: '10.0.0.2' })).statusCode, 401);
      assert.equal((await app.inject({ url, headers: { 'x-cat-cafe-user': 'owner' } })).statusCode, 401);
      assert.equal((await app.inject({ url, headers: { 'x-test-session': 'other' } })).statusCode, 403);
    }
    const res = await app.inject({
      url: '/api/memory/catalog',
      headers: { 'x-test-session': 'owner' },
      remoteAddress: '10.0.0.2',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().collections[0].docCount, 1);
    assert.equal(res.json().collections[0].lastDocumentUpdatedAt, '2026-09-01');
    assert.equal('lastIndexedAt' in res.json().collections[0], false);
    assert.equal(res.body.includes('/secret/path'), false);
    assert.equal(res.body.includes('public-feature'), false);
  } finally {
    await app.close();
  }
});
test('approved candidate is not called collected; private orphan candidate is withheld; source refs are not exported', async () => {
  const { app } = await setup();
  try {
    const result = await app.inject({ url: '/api/memory/library-feed', headers: { 'x-test-session': 'owner' } });
    assert.equal(result.json().pending.length, 0);
    assert.equal(result.json().processed[0].state, '已批准 · 收录结果没有记录');
    assert.equal(result.body.includes('外人私有'), false);
    assert.equal(result.body.includes('private raw ref'), false);
  } finally {
    await app.close();
  }
});
test('maintenance counts check categories, excludes pending knowledge, and exports no anchors/search payloads', async () => {
  const { app } = await setup();
  try {
    const response = await app.inject({ url: '/api/memory/maintenance', headers: { 'x-test-session': 'owner' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().checks.length, 6);
    assert.equal(response.json().pendingChecks + response.json().passedChecks, 6);
    assert.equal(response.body.includes('public-feature'), false);
    assert.equal(response.body.includes('knowledgeFeed'), false);
    assert.equal('lastRebuildAt' in response.json(), false);
  } finally {
    await app.close();
  }
});
test('broken evidence read is an error response, never an all-healthy zero report', async () => {
  const { app, db } = await setup();
  try {
    db.close();
    assert.equal(
      (await app.inject({ url: '/api/memory/maintenance', headers: { 'x-test-session': 'owner' } })).statusCode,
      500,
    );
  } finally {
    await app.close();
  }
});
