import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { AssetCanonService } from '../src/domains/collaborative-content/asset-canon/service.js';
import { registerAssetCanonRoutes } from '../src/routes/asset-canon-routes.js';
import { canonCat, canonFixture, canonHuman } from './helpers/asset-canon-fixture.js';

test('opening a selected asset rechecks owner, current canon, root access and immutable bytes', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const a = await f.mark(await f.image('a.png', 'a'));
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = request.headers['x-fixture-user'] === 'owner' ? 'owner' : null;
  });
  registerAssetCanonRoutes(app, f.service, f.assets);
  const url = `/api/asset-canon/${encodeURIComponent(a.indexedVersionRef)}/bytes?threadId=film&purpose=select&expectedRevision=1`;
  assert.equal((await app.inject({ url })).statusCode, 401);
  const headers = { 'x-fixture-user': 'owner' };
  assert.equal((await app.inject({ url, headers: { ...headers, 'x-invocation-id': 'cat' } })).statusCode, 401);
  const range = await app.inject({ url, headers: { ...headers, range: 'bytes=0-0' } });
  assert.equal(range.statusCode, 206, range.body);
  assert.equal(range.body, 'a');
  assert.equal(range.headers['content-range'], 'bytes 0-0/1');
  await f.mark(a, 'failed');
  assert.equal((await app.inject({ url, headers })).statusCode, 409);
  const current = await f.mark(a);
  const newUrl = url.replace('expectedRevision=1', `expectedRevision=${current.revision}`);
  await writeFile(join(f.root, 'a.png'), 'changed');
  assert.equal((await app.inject({ url: newUrl, headers })).statusCode, 409);
  f.denied.add('root');
  assert.equal((await app.inject({ url: newUrl, headers })).statusCode, 403);
});

test('canonical locator normalization retains the complete original operation for an identical replay', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const a = await f.image('a.png');
  const service = new AssetCanonService({
    ...f.service.deps,
    inspect: async (version) => ({
      ...(await f.assets.inspect({ ...version.locator, rootId: 'root' })),
      locator: { ...version.locator, rootId: 'root' },
    }),
  });
  const command = {
    action: 'index-asset',
    operationId: 'alias-index',
    name: 'a.png',
    kind: 'image',
    version: { ...a.version, locator: { ...a.version.locator, rootId: 'alias' } },
  };
  const receipt = await service.run(command, canonCat);
  assert.deepEqual(await service.run(command, canonCat), receipt);
});

test('two F309 connections race one asset CAS, retaining one winner and its original receipt', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const a = await f.image('a.png');
  const second = new ArtifactReviewStore(f.dbPath);
  t.after(() => second.close());
  const other = new AssetCanonService({
    ...f.service.deps,
    store: second.works.assets,
    contextStore: second.works.contexts,
  });
  const command = {
    action: 'set-asset-status',
    indexedVersionRef: a.indexedVersionRef,
    expectedRevision: 0,
    status: 'canonical',
    reason: '并发标记',
    operationId: 'first',
  };
  const results = await Promise.allSettled([
    f.service.run(command, canonCat),
    other.run({ ...command, operationId: 'second' }, canonCat),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(second.works.assets.get('owner', a.indexedVersionRef)!.revision, 1);
  assert.equal(second.works.assets.history('owner', a.indexedVersionRef).length, 1);
});
