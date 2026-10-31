import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { MessageSearchService } from '../dist/domains/memory/MessageSearchService.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { evidenceRoutes } from '../dist/routes/evidence.js';

describe('click-time canonical source admission', () => {
  let app;
  let message;
  let thread;
  let currentIndex;
  let readIndexState;
  const headers = { 'x-cat-cafe-user': 'owner' };
  const url = '/api/evidence/navigation-source?threadId=visible&messageId=old';
  beforeEach(async () => {
    thread = { id: 'visible', title: 'Owned', createdBy: 'owner' };
    message = {
      id: 'old',
      threadId: 'visible',
      userId: 'owner',
      catId: null,
      content: 'Canonical original body.',
      timestamp: 1000,
    };
    currentIndex = true;
    readIndexState = () => ({ current: currentIndex, suppressThreadTitle: !currentIndex });
    const service = new MessageSearchService({
      threadStore: { get: async (id) => (id === 'visible' ? thread : null), list: async () => [thread] },
      messageStore: { getById: async (id) => (id === 'old' ? message : null) },
      evidenceStore: {
        searchMessagePassages: async () =>
          assert.fail('a source check must not re-rank or replace its immutable result collection'),
        readMessagePassageState: (candidate) => readIndexState(candidate),
      },
    });
    app = Fastify();
    await app.register(evidenceRoutes, { evidenceStore: { search: async () => [] }, messageSearchService: service });
    await app.ready();
  });
  afterEach(() => app.close());
  it('admits only the exact current canonical source and never returns its body or title', async () => {
    const res = await app.inject({ url, headers });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      status: 'available',
      target: {
        threadId: 'visible',
        messageId: 'old',
        contentRevision: createHash('sha256').update(message.content).digest('hex'),
      },
      updated: false,
    });
    assert(!res.body.includes(message.content));
    assert(!res.body.includes(thread.title));
  });
  it('requires direct-local authorization and ignores caller identity/source parameters', async () => {
    assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { ...headers, 'x-forwarded-for': '192.0.2.1' } })).statusCode, 401);
    const res = await app.inject({ url: `${url}&userId=other&catId=opus55&sourceMessageId=forged`, headers });
    assert.equal(res.statusCode, 200);
  });
  it('rechecks deletion, queue state, wrong ownership and prepared recall suppression before navigation', async () => {
    for (const delta of [{ deletedAt: 5 }, { _tombstone: true }, { deliveryStatus: 'queued' }, { userId: 'other' }]) {
      const old = message;
      message = { ...old, ...delta };
      assert.equal((await app.inject({ url, headers })).statusCode, 404, JSON.stringify(delta));
      message = old;
    }
    currentIndex = false;
    assert.equal((await app.inject({ url, headers })).statusCode, 404);
  });
  it('does not reveal whether a revoked or nonexistent thread exists', async () => {
    thread.createdBy = 'other';
    const revoked = await app.inject({ url, headers });
    const absent = await app.inject({ url: url.replace('visible', 'absent'), headers });
    assert.equal(revoked.statusCode, 403);
    assert.equal(absent.statusCode, 403);
    assert.deepEqual(revoked.json(), absent.json());
  });
  it('reports an edited source without changing its coordinates, and checks only thread access for return', async () => {
    const res = await app.inject({ url: `${url}&contentRevision=older-revision`, headers });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().updated, true);
    assert.equal(res.json().target.messageId, 'old');
    message.deletedAt = 5;
    currentIndex = false;
    const returning = await app.inject({ url: '/api/evidence/navigation-source?threadId=visible', headers });
    assert.equal(returning.statusCode, 200);
    assert.deepEqual(returning.json(), { status: 'available', target: { threadId: 'visible' }, updated: false });
    assert.equal((await app.inject({ url: '/api/evidence/navigation-source?threadId=', headers })).statusCode, 400);
  });

  it('uses real SQLite canonical-content and prepared-suppression guards instead of trusting a saved revision', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    try {
      await store.upsert([
        {
          anchor: 'thread-visible',
          kind: 'thread',
          status: 'active',
          title: 'Owned',
          summary: '',
          updatedAt: '2026-10-02T00:00:00Z',
        },
      ]);
      const db = store.getDb();
      db.prepare(
        'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('thread-visible', 'msg-old', message.content, 'user', 0, '2026-10-02T00:00:00Z');
      readIndexState = (candidate) => store.readMessagePassageState(candidate);
      const first = await app.inject({ url, headers });
      assert.equal(first.statusCode, 200);
      const oldRevision = first.json().target.contentRevision;
      message.content = 'The source has been edited.';
      assert.equal(
        (await app.inject({ url: `${url}&contentRevision=${oldRevision}`, headers })).statusCode,
        404,
        'stale indexed content cannot admit a cached target',
      );
      db.prepare('UPDATE evidence_passages SET content=? WHERE passage_id=?').run(message.content, 'msg-old');
      const edited = await app.inject({ url: `${url}&contentRevision=${oldRevision}`, headers });
      assert.equal(edited.statusCode, 200);
      assert.equal(edited.json().updated, true);
      db.prepare(
        "INSERT INTO message_recall_index_suppressions (doc_anchor, passage_id, lease_id, state, prepared_at) VALUES (?, ?, ?, 'prepared', ?)",
      ).run('thread-visible', 'msg-old', 'prepared-fixture', '2026-10-02T00:00:00Z');
      assert.equal(
        (await app.inject({ url, headers })).statusCode,
        404,
        'prepared recall blocks even though canonical content still exists',
      );
      assert.equal(message.content, 'The source has been edited.');
    } finally {
      store.close();
    }
  });
});
