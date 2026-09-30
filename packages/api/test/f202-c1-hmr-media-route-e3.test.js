import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';

const { FileMessagingMediaLedger } = await import('../dist/domains/messaging/media-ledger.js');
const { sessionAuthPlugin, sessionRoute } = await import('../dist/infrastructure/session-auth.js');
const { mediaRoutes } = await import('../dist/routes/media-routes.js');

let app;
let root;
let ledger;
let hmrId;
let bytes;
let ownerCookie;
let nonOwnerCookie;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'f202-e3-media-'));
  ledger = new FileMessagingMediaLedger(join(root, 'media'));
  bytes = Buffer.from('private media bytes that must never enter uploads');
  hmrId = await ledger.register(bytes, { mimeType: 'image/png' });
  app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'owner-user' });
  await app.register(mediaRoutes, { ledger, ownerUserId: 'owner-user' });
  await app.ready();
  ownerCookie = String((await app.inject({ method: 'GET', url: '/api/session' })).headers['set-cookie']).split(';')[0];
  nonOwnerCookie = String(
    (await app.inject({ method: 'GET', url: '/api/session', headers: { 'x-forwarded-for': '198.51.100.2' } })).headers[
      'set-cookie'
    ],
  ).split(';')[0];
});

after(async () => {
  await app?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test('owner session streams verified HMR bytes with private, non-sniffable headers', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/media/hmr/${hmrId}`, headers: { cookie: ownerCookie } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.rawPayload, bytes);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['content-length'], String(bytes.length));
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['content-security-policy'], 'sandbox');
  assert.ok(!JSON.stringify(res.headers).includes(root), 'private locator must not reach HTTP');
  await assert.rejects(readdir(join(root, 'uploads')), { code: 'ENOENT' });
});

test('no session, plugin bearer, and non-owner session cannot read media', async () => {
  for (const headers of [{}, { authorization: 'Bearer plugin-token' }, { cookie: nonOwnerCookie }]) {
    const res = await app.inject({ method: 'GET', url: `/api/media/hmr/${hmrId}`, headers });
    assert.equal(res.statusCode, 401);
    assert.ok(!res.body.includes('private media bytes'));
  }
});

test('invalid, unknown, and tampered HMR return the same non-disclosing 404', async () => {
  const headers = { cookie: ownerCookie };
  const invalid = await app.inject({ method: 'GET', url: '/api/media/hmr/hmr_bad', headers });
  const invalidPath = await app.inject({ method: 'GET', url: '/api/media/hmr/hmr_bad/escape', headers });
  const unknown = await app.inject({ method: 'GET', url: `/api/media/hmr/hmr_${'A'.repeat(32)}`, headers });
  const path = await ledger.resolveTrustedBlobPath(hmrId);
  assert.ok(path);
  await writeFile(path, Buffer.alloc(bytes.length, 0x58));
  const tampered = await app.inject({ method: 'GET', url: `/api/media/hmr/${hmrId}`, headers });
  for (const res of [invalid, invalidPath, unknown, tampered]) assert.equal(res.statusCode, 404);
  assert.equal(invalid.body, invalidPath.body);
  assert.equal(invalid.body, unknown.body);
  assert.equal(unknown.body, tampered.body);
  assert.ok(!tampered.body.includes(root));
});
