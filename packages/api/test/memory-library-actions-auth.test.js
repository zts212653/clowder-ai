import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { LibraryCatalog } from '../dist/domains/memory/LibraryCatalog.js';
import { knowledgeFeedRoutes } from '../dist/routes/knowledge-feed.js';
import { libraryRoutes } from '../dist/routes/library.js';
import { memoryLibraryFeed } from '../dist/routes/memory-library-read.js';

test('owner writes cannot target or mutate private collections outside the read principal', async () => {
  const app = Fastify();
  const db = new Database(':memory:');
  let transitions = 0;
  app.addHook('onRequest', async (req) => {
    req.sessionUserId = 'owner';
  });
  const privateManifest = { id: 'domain:private', sensitivity: 'private', ownerUserId: 'owner', status: 'active' };
  const otherManifest = { id: 'domain:other', sensitivity: 'private', ownerUserId: 'other', status: 'active' };
  const publicManifest = { id: 'project:public', sensitivity: 'internal', status: 'active' };
  const markers = [
    { id: 'mine', sourceCollectionId: privateManifest.id },
    { id: 'other', sourceCollectionId: otherManifest.id },
    { id: 'public', sourceCollectionId: publicManifest.id },
    { id: 'orphan', sourceSensitivity: 'private' },
  ];
  await knowledgeFeedRoutes(app, {
    ownerUserId: 'owner',
    db,
    catalog: { list: () => [privateManifest, otherManifest, publicManifest] },
    markerQueue: {
      list: async () => markers,
      transition: async () => {
        transitions++;
      },
    },
  });
  try {
    for (const markerId of ['mine', 'other', 'orphan']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/knowledge/reject',
        payload: { markerId },
        headers: { 'x-forwarded-for': '10.0.0.2' },
      });
      assert.equal(res.statusCode, 404, markerId);
    }
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/knowledge/reject', payload: { markerId: 'other' } })).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/knowledge/approve',
          payload: { markerId: 'public', targetCollectionId: 'domain:other' },
        })
      ).statusCode,
      404,
    );
    assert.equal(transitions, 0);
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/knowledge/reject', payload: { markerId: 'mine' } })).statusCode,
      200,
    );
    assert.equal(transitions, 1);
  } finally {
    await app.close();
    db.close();
  }
});

test('configured library writers require the owner session before touching stores or the filesystem', async () => {
  const app = Fastify();
  const db = new Database(':memory:');
  let transitions = 0;
  app.addHook('onRequest', async (req) => {
    req.sessionUserId = req.headers['x-test-session'];
  });
  const queue = {
    list: async () => [{ id: 'm1' }],
    transition: async () => {
      transitions++;
    },
  };
  await knowledgeFeedRoutes(app, { markerQueue: queue, db, ownerUserId: 'owner' });
  await app.register(libraryRoutes, { catalog: new LibraryCatalog(), stores: new Map(), privateOwnerUserId: 'owner' });
  await app.ready();
  try {
    for (const url of [
      '/api/knowledge/approve',
      '/api/knowledge/reject',
      '/api/knowledge/undo',
      '/api/library/register',
      '/api/library/bind-dry-run',
      '/api/library/domain:x/rebuild',
    ]) {
      const payload = { markerId: 'm1', root: '/do-not-scan', id: 'domain:x' };
      assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 401, url);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload,
            headers: { 'x-cat-cafe-user': 'owner', origin: 'http://localhost:3003' },
          })
        ).statusCode,
        401,
        url,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url, payload, headers: { 'x-test-session': 'other' } })).statusCode,
        403,
        url,
      );
    }
    assert.equal(transitions, 0);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/library/register',
          payload: {},
          headers: {
            'x-test-session': 'owner',
            'x-forwarded-for': '10.0.0.2',
          },
        })
      ).statusCode,
      403,
    );
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/knowledge/reject',
      payload: { markerId: 'm1' },
      headers: { 'x-test-session': 'owner' },
    });
    assert.equal(rejected.statusCode, 200);
    assert.equal(transitions, 1);
  } finally {
    await app.close();
    db.close();
  }
});

test('candidate target confirmation receives only visible collection coordinates and authoritative source sensitivity', () => {
  const result = memoryLibraryFeed(
    [
      {
        id: 'visible',
        source: 'raw source ref',
        content: '内容',
        status: 'captured',
        createdAt: '2026-10-03',
        sourceCollectionId: 'domain:mine',
      },
      {
        id: 'hidden',
        content: '隐藏内容',
        status: 'captured',
        createdAt: '2026-10-03',
        sourceCollectionId: 'domain:other',
      },
    ],
    [{ id: 'domain:mine', displayName: '我的资料', sensitivity: 'private', root: '/secret/root' }],
  );
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].sourceCollectionId, 'domain:mine');
  assert.equal(result.pending[0].sourceVisibility, 'private');
  assert.equal(JSON.stringify(result).includes('/secret/root'), false);
  assert.equal(JSON.stringify(result).includes('raw source ref'), false);
});
