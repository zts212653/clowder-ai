import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { memoryPageReadRoutes } from '../dist/routes/memory-page-read.js';

async function withCatalog(run) {
  const root = mkdtempSync(join(tmpdir(), 'f321-default-'));
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'other'));
  symlinkSync(join(root, 'docs'), join(root, 'alias'));
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  const manifests = [
    {
      id: 'domain:docs',
      displayName: '实际文档库',
      root: join(root, 'docs'),
      sensitivity: 'internal',
      status: 'active',
    },
  ];
  const stores = new Map([[manifests[0].id, store]]);
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.sessionUserId = 'owner';
  });
  await app.register(memoryPageReadRoutes, {
    ownerUserId: 'owner',
    docsRoot: join(root, 'alias'),
    catalog: { list: () => manifests },
    stores,
    evidenceDb: store.getDb(),
    markerQueue: { list: async () => [] },
  });
  try {
    await run({ app, root, manifests, stores });
  } finally {
    await app.close();
    store.getDb().close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('default is the readable canonical docsRoot match, independent of collection id or display name', async () => {
  await withCatalog(async ({ app, root, manifests }) => {
    const response = await app.inject('/api/memory/catalog');
    assert.equal(response.json().defaultTargetCollectionId, 'domain:docs');
    assert.equal(response.body.includes(root), false, 'never export the physical root');
    manifests[0].root = join(root, 'other');
    assert.equal((await app.inject('/api/memory/catalog')).json().defaultTargetCollectionId, null);
  });
});

test('archived, unreadable and ambiguous root matches do not choose a default', async () => {
  await withCatalog(async ({ app, manifests, stores }) => {
    manifests[0].status = 'archived';
    assert.equal((await app.inject('/api/memory/catalog')).json().defaultTargetCollectionId, null);
    manifests[0].status = 'active';
    const store = stores.get('domain:docs');
    stores.clear();
    assert.equal((await app.inject('/api/memory/catalog')).json().defaultTargetCollectionId, null);
    stores.set('domain:docs', store);
    stores.set('domain:duplicate', store);
    manifests.push({ ...manifests[0], id: 'domain:duplicate' });
    assert.equal((await app.inject('/api/memory/catalog')).json().defaultTargetCollectionId, null);
  });
});

test('hidden private root matches never become a default through an owner proxy session', async () => {
  await withCatalog(async ({ app, manifests }) => {
    manifests[0].sensitivity = 'private';
    manifests[0].ownerUserId = 'owner';
    const proxied = await app.inject({ url: '/api/memory/catalog', headers: { 'x-forwarded-for': '10.0.0.2' } });
    assert.equal(proxied.json().collections.length, 0);
    assert.equal(proxied.json().defaultTargetCollectionId, null);
    assert.equal((await app.inject('/api/memory/catalog')).json().defaultTargetCollectionId, 'domain:docs');
  });
});
