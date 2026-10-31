import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MemberCanonService } from '../src/domains/collaborative-content/asset-canon/member-service.js';
import { catsRoutes } from '../src/routes/cats.js';
import { registerMemberCanonResponse } from '../src/routes/member-canon-response.js';
import { canonFixture, canonHuman } from './helpers/asset-canon-fixture.js';

async function selectedMember(f: Awaited<ReturnType<typeof canonFixture>>) {
  const asset = await f.mark(
    await f.image('avatar.png', 'original-avatar-bytes', [
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
      reason: 'Human selection',
    },
    canonHuman,
  );
  return members;
}

for (const mixed of [false, true]) {
  test(`member PATCH refuses a linked avatar before any profile or binding write (mixed=${mixed})`, async (t) => {
    const f = await canonFixture();
    t.after(f.cleanup);
    const members = await selectedMember(f);
    const app = Fastify();
    t.after(() => app.close());
    await app.register(catsRoutes, { memberAssets: () => members });
    const before = JSON.stringify({
      binding: members.binding('director'),
      snapshot: f.store.works.assets.snapshot('owner'),
    });
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/cats/director',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { avatar: '/uploads/another.png', ...(mixed ? { nickname: 'must not save' } : {}) },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, mixed ? 'canon_avatar_mixed_patch' : 'canon_avatar_selection_required');
    assert.equal(
      JSON.stringify({ binding: members.binding('director'), snapshot: f.store.works.assets.snapshot('owner') }),
      before,
    );
  });
}

test('the HTTP catalog projection reads the unique canon binding and retains unrelated profile data', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const members = await selectedMember(f);
  const app = Fastify();
  t.after(() => app.close());
  registerMemberCanonResponse(app, () => members);
  app.get('/catalog', async () => ({ cats: [{ id: 'director', nickname: 'kept', avatar: '/legacy.png' }] }));
  const response = await app.inject({ url: '/catalog', headers: { 'x-cat-cafe-user': 'owner' } });
  assert.equal(response.statusCode, 200, response.body);
  const cat = response.json().cats[0];
  assert.equal(cat.nickname, 'kept');
  assert.equal(cat.avatar, '/api/cats/director/avatar?bindingRevision=1');
  assert.equal(cat.visualAssets.state, 'selected');
  assert.equal(cat.visualAssets.bindingRevision, 1);
});
