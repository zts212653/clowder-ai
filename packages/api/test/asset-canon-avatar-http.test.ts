import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MemberCanonService } from '../src/domains/collaborative-content/asset-canon/member-service.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { registerMemberCanonRoutes } from '../src/routes/member-canon-routes.js';
import { canonFixture, canonHuman } from './helpers/asset-canon-fixture.js';

async function fixture(t: TestContext) {
  const f = await canonFixture();
  t.after(f.cleanup);
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
      operationId: 'selected',
      reason: 'Human selected avatar',
    },
    canonHuman,
  );
  const app = Fastify();
  t.after(() => app.close());
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'owner' });
  registerMemberCanonRoutes(app, {
    members,
    assets: f.assets,
    source: new WorkspaceContentSourceService({
      ownerUserId: 'owner',
      resolveWorktreeRoot: async (id) => ({ canonicalWorktreeId: id, root: f.root }),
    }),
  });
  const login = await app.inject({ url: '/api/session' });
  assert.equal(login.json().userId, 'owner');
  const headers = {
    cookie: String(login.headers['set-cookie']).split(';')[0] ?? '',
    'x-csrf-token': login.json().csrfToken,
  };
  return { f, app, asset, members, headers };
}

const versioned = '/api/cats/director/avatar?bindingRevision=1';
const immutable = 'private, max-age=31536000, immutable';

test('the fixed current avatar URL permits browser reuse and keeps session partitions distinct', async (t) => {
  const { app, headers } = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = await app.inject({ url: versioned, headers });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.body, 'original-avatar-bytes');
    assert.equal(result.headers['cache-control'], immutable);
    assert.match(String(result.headers.vary), /(?:^|,\s*)Cookie(?:,|$)/i);
  }
  const partial = await app.inject({ url: versioned, headers: { ...headers, range: 'bytes=0-7' } });
  assert.equal(partial.statusCode, 206, partial.body);
  assert.equal(partial.body, 'original');
  assert.equal(partial.headers['cache-control'], immutable);
  assert.equal(partial.headers['content-range'], 'bytes 0-7/21');
  const latest = await app.inject({ url: '/api/cats/director/avatar', headers });
  assert.equal(latest.statusCode, 200, latest.body);
  assert.equal(latest.headers['cache-control'], 'private, no-store');
  const stale = await app.inject({ url: '/api/cats/director/avatar?bindingRevision=2', headers });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.headers['cache-control'], 'private, no-store');
  const invalidRange = await app.inject({ url: versioned, headers: { ...headers, range: 'bytes=9999-' } });
  assert.equal(invalidRange.statusCode, 416, invalidRange.body);
  assert.equal(invalidRange.headers['cache-control'], 'private, no-store');
});

test('avatar bytes accept the valid owner session from LAN or a proxy, ahead of a spoofed identity header', async (t) => {
  const { app, headers } = await fixture(t);
  for (const connection of [
    {
      remoteAddress: '192.168.1.20',
      headers: { ...headers, origin: 'http://192.168.1.2:5102', 'x-cat-cafe-user': 'other-user' },
    },
    {
      remoteAddress: '100.64.0.20',
      headers: { ...headers, 'x-forwarded-for': '100.64.0.21', 'x-forwarded-proto': 'https' },
    },
    { remoteAddress: '127.0.0.1', headers: { ...headers, 'x-forwarded-for': '192.168.1.20' } },
  ]) {
    const result = await app.inject({ url: versioned, ...connection });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.body, 'original-avatar-bytes');
    assert.equal(result.headers['cache-control'], immutable);
  }
  for (const untrusted of [
    { headers: { 'x-cat-cafe-user': 'owner' } },
    { headers: { cookie: 'cat_cafe_session=invalid', 'x-cat-cafe-user': 'owner' } },
  ]) {
    const denied = await app.inject({ url: versioned, remoteAddress: '192.168.1.20', ...untrusted });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.headers['cache-control'], 'private, no-store');
  }
  for (const key of ['x-invocation-id', 'x-callback-token', 'x-agent-key-secret']) {
    const denied = await app.inject({ url: versioned, headers: { ...headers, [key]: 'cat-credential' } });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.headers['cache-control'], 'private, no-store');
  }
  const unpaired = await app.inject({ url: '/api/session', remoteAddress: '192.168.1.20' });
  const denied = await app.inject({
    url: versioned,
    remoteAddress: '192.168.1.20',
    headers: {
      cookie: String(unpaired.headers['set-cookie']).split(';')[0] ?? '',
      'x-cat-cafe-user': 'owner',
    },
  });
  assert.equal(denied.statusCode, 403, denied.body);
});

test('remote sessions and agent headers cannot select or upload; rejection leaves canon unchanged', async (t) => {
  const { app, f, asset, members, headers } = await fixture(t);
  const before = JSON.stringify({
    binding: members.binding('director'),
    snapshot: f.store.works.assets.snapshot('owner'),
  });
  const bodies = [
    {
      url: '/api/cats/director/canon-avatar',
      payload: {
        mode: 'clear',
        operationId: 'forbidden-selection',
        reason: 'must not mutate',
        expectedBindingRevision: 1,
      },
    },
    {
      url: '/api/cats/director/canon-avatar/upload',
      payload: {
        uploadUrl: '/uploads/avatar-1793016139660-3f79e0c6.png',
        operationId: 'forbidden-upload',
        reason: 'must not mutate',
        expectedBindingRevision: 1,
      },
    },
  ];
  const connections = [
    { remoteAddress: '192.168.1.20', headers },
    { remoteAddress: '127.0.0.1', headers: { ...headers, 'x-forwarded-for': '192.168.1.20' } },
    ...['x-invocation-id', 'x-callback-token', 'x-agent-key-secret'].map((key) => ({
      remoteAddress: '127.0.0.1',
      headers: { ...headers, [key]: 'cat-credential' },
    })),
  ];
  for (const connection of connections)
    for (const body of bodies) {
      const denied = await app.inject({ method: 'POST', ...body, ...connection });
      assert.equal(denied.statusCode, 403, denied.body);
    }
  assert.equal(
    JSON.stringify({ binding: members.binding('director'), snapshot: f.store.works.assets.snapshot('owner') }),
    before,
  );
  const direct = await app.inject({
    method: 'POST',
    url: '/api/cats/director/canon-avatar',
    headers,
    payload: {
      mode: 'set',
      operationId: 'direct-human',
      reason: 'direct Human still selects',
      expectedBindingRevision: 1,
      indexedVersionRef: asset.indexedVersionRef,
      expectedAssetRevision: asset.revision,
    },
  });
  assert.equal(direct.statusCode, 200, direct.body);
  assert.equal(members.binding('director')?.bindingRevision, 2);
  const old = await app.inject({ url: versioned, headers });
  assert.equal(old.statusCode, 409, old.body);
  assert.equal(old.headers['cache-control'], 'private, no-store');
  const current = await app.inject({ url: '/api/cats/director/avatar?bindingRevision=2', headers });
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(current.headers['cache-control'], immutable);
});

test('avatar revocation, missing and changed files never become cacheable or fall back', async (t) => {
  const { app, f, headers, members } = await fixture(t);
  f.denied.add('root');
  const denied = await app.inject({ url: versioned, headers });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.headers['cache-control'], 'private, no-store');
  f.denied.clear();
  await writeFile(join(f.root, 'avatar.png'), 'changed');
  const changed = await app.inject({ url: versioned, headers });
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(changed.headers['cache-control'], 'private, no-store');
  await members.select(
    'director',
    { mode: 'clear', operationId: 'clear', reason: 'explicit test clear', expectedBindingRevision: 1 },
    canonHuman,
  );
  const cleared = await app.inject({ url: versioned, headers });
  assert.equal(cleared.statusCode, 410, cleared.body);
  assert.equal(cleared.headers['cache-control'], 'private, no-store');
});
