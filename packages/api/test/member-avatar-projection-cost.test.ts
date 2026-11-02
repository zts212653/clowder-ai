import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import Fastify from 'fastify';
import { MemberCanonService } from '../src/domains/collaborative-content/asset-canon/member-service.js';
import { registerMemberCanonResponse } from '../src/routes/member-canon-response.js';
import { canonFixture, canonHuman } from './helpers/asset-canon-fixture.js';

async function fixture(t: TestContext) {
  const f = await canonFixture();
  t.after(f.cleanup);
  const asset = await f.mark(
    await f.image('avatar.png', 'original-avatar', [
      {
        subjectRef: { kind: 'member', catId: 'director' },
        representation: 'member-avatar',
        styleKey: 'test',
        role: 'avatar',
      },
    ]),
  );
  const members = new MemberCanonService(f.service, 'owner');
  await members.select(
    'director',
    {
      mode: 'set',
      indexedVersionRef: asset.indexedVersionRef,
      expectedAssetRevision: asset.revision,
      expectedBindingRevision: 0,
      operationId: 'select-avatar',
      reason: 'Human selected original',
    },
    canonHuman,
  );
  const app = Fastify();
  t.after(() => app.close());
  registerMemberCanonResponse(app, () => members);
  // Exercise the actual catalog preSerialization hook with its real SQLite,
  // file reader and member service; config/catalog assembly is a separate cost.
  app.get('/api/cats', async () => ({ cats: [{ id: 'director', nickname: 'kept', avatar: '/legacy.png' }] }));
  const request = () => app.inject({ url: '/api/cats', headers: { 'x-cat-cafe-user': 'owner' } });
  return { ...f, app, request, members, asset };
}

test('catalog avatar availability does not enumerate all asset bindings', async (t) => {
  const f = await fixture(t);
  const bindingReads = t.mock.method(f.store.works.assets, 'bindings');
  const response = await f.request();
  assert.equal(response.statusCode, 200, response.body);
  const cat = response.json().cats[0];
  assert.equal(cat.nickname, 'kept');
  assert.equal(cat.avatar, '/api/cats/director/avatar?bindingRevision=1');
  assert.equal(cat.visualAssets.state, 'selected');
  assert.equal(cat.visualAssets.indexedVersionRef, f.asset.indexedVersionRef);
  assert.equal(bindingReads.mock.callCount(), 0, 'Member availability must not scan every unrelated asset binding');
});

test('complete asset reads still include their actual current bindings', async (t) => {
  const f = await fixture(t);
  const bindingReads = t.mock.method(f.store.works.assets, 'bindings');
  const item = await f.service.access.item(f.asset, canonHuman);
  assert.equal(item.fileState, 'available');
  assert.equal(item.canWrite, true);
  assert.equal(item.bindings.length, 1);
  assert.equal(item.bindings[0]?.bindingRef, f.members.binding('director')?.bindingRef);
  assert.equal(bindingReads.mock.callCount(), 1);
});

test('catalog availability checks bytes freshly and preserves the selected binding when bytes change', async (t) => {
  const f = await fixture(t);
  const selected = await f.request();
  assert.equal(selected.json().cats[0].visualAssets.state, 'selected');
  await writeFile(join(f.root, 'avatar.png'), 'changed-on-disk');
  const changed = await f.request();
  assert.equal(changed.statusCode, 200, changed.body);
  const cat = changed.json().cats[0];
  assert.equal(cat.visualAssets.state, 'unavailable');
  assert.equal(cat.avatar, '/api/cats/director/avatar?bindingRevision=1');
  assert.equal(f.members.binding('director')?.indexedVersionRef, f.asset.indexedVersionRef);
});

test('revocation during file inspection is caught by the final authorization and does not expose the version ref', async (t) => {
  const f = await fixture(t);
  const inspect = f.service.deps.inspect.bind(f.service.deps);
  t.mock.method(f.service.deps, 'inspect', async (...args: Parameters<typeof inspect>) => {
    const result = await inspect(...args);
    f.denied.add('producer');
    return result;
  });
  const response = await f.request();
  assert.equal(response.statusCode, 200, response.body);
  const cat = response.json().cats[0];
  assert.equal(cat.visualAssets.state, 'unavailable');
  assert.equal(cat.visualAssets.indexedVersionRef, undefined);
  assert.equal(cat.avatar, '/api/cats/director/avatar?bindingRevision=1');
});
