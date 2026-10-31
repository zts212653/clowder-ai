import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

describe('Query Capture — collection routing metadata (AC-E1)', () => {
  let app;
  let db;

  beforeEach(() => {
    process.env.F163_AUTHORITY_BOOST = 'on';
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS f163_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_type TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        effective_flags TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        origin TEXT DEFAULT 'user'
      );
      CREATE TABLE IF NOT EXISTS f163_cohorts (
        thread_id TEXT PRIMARY KEY,
        variant_id TEXT NOT NULL
      );
    `);
  });

  afterEach(async () => {
    delete process.env.F163_AUTHORITY_BOOST;
    if (app) await app.close();
    if (db) db.close();
  });

  function mockStore() {
    return {
      search: async () => [
        { anchor: 'test:a', kind: 'feature', status: 'active', title: 'A', updatedAt: '2026-01-01' },
      ],
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
      health: async () => true,
      initialize: async () => {},
      getDb: () => db,
    };
  }

  function mockResolver() {
    return {
      resolve: async (query, opts) => ({
        results: [
          { anchor: 'world:lexander:doc/lore', kind: 'lore', status: 'active', title: 'Lore', updatedAt: '2026-01-01' },
          {
            anchor: 'project:cat-cafe:doc/f186',
            kind: 'feature',
            status: 'active',
            title: 'F186',
            updatedAt: '2026-01-01',
          },
        ],
        sources: ['project'],
        query,
        collectionGroups: [
          {
            collectionId: 'world:lexander',
            sensitivity: 'private',
            status: 'ok',
            durationMs: 5,
            items: [
              {
                anchor: 'world:lexander:doc/lore',
                kind: 'lore',
                status: 'active',
                title: 'Lore',
                updatedAt: '2026-01-01',
              },
            ],
          },
          {
            collectionId: 'project:cat-cafe',
            sensitivity: 'internal',
            status: 'ok',
            durationMs: 3,
            items: [
              {
                anchor: 'project:cat-cafe:doc/f186',
                kind: 'feature',
                status: 'active',
                title: 'F186',
                updatedAt: '2026-01-01',
              },
            ],
          },
        ],
      }),
    };
  }

  it('captures scope/dimension/collections/topKPerCollection in f163_logs payload', async () => {
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: {
        recall: async () => [],
        retain: async () => {},
        reflect: async () => '',
        ensureBank: async () => {},
        isHealthy: async () => true,
      },
      sharedBank: 'test',
      evidenceStore: mockStore(),
      knowledgeResolver: mockResolver(),
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=lore&scope=docs&dimension=library&collections=world:lexander,project:cat-cafe',
    });

    assert.equal(res.statusCode, 200);

    const row = db.prepare('SELECT payload FROM f163_logs WHERE log_type = ?').get('search');
    assert.ok(row, 'f163_logs must have a search entry');
    const payload = JSON.parse(row.payload);

    assert.equal(payload.scope, 'docs', 'payload must include scope');
    assert.equal(payload.dimension, 'library', 'payload must include dimension');
    assert.deepEqual(payload.collections, ['world:lexander', 'project:cat-cafe'], 'payload must include collections');
    assert.ok(payload.topKPerCollection, 'payload must include topKPerCollection');
    assert.deepEqual(payload.topKPerCollection['world:lexander'], { count: 1, anchors: ['world:lexander:doc/lore'] });
    assert.deepEqual(payload.topKPerCollection['project:cat-cafe'], {
      count: 1,
      anchors: ['project:cat-cafe:doc/f186'],
    });
  });

  it('tags origin=eval for eval domain threads (F192 server-side detection)', async () => {
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: {
        recall: async () => [],
        retain: async () => {},
        reflect: async () => '',
        ensureBank: async () => {},
        isHealthy: async () => true,
      },
      sharedBank: 'test',
      evidenceStore: mockStore(),
      knowledgeResolver: mockResolver(),
    });
    await app.ready();

    // Search with x-cat-cafe-thread-id header matching eval domain convention.
    // The header is the trusted source (set by MCP server from session env),
    // NOT the public query param currentThreadId.
    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
      headers: { 'x-cat-cafe-thread-id': 'thread_eval_memory' },
    });
    assert.equal(res.statusCode, 200);

    const evalRow = db.prepare("SELECT origin FROM f163_logs WHERE log_type = 'search'").get();
    assert.ok(evalRow, 'f163_logs must have a search entry');
    assert.equal(evalRow.origin, 'eval', 'eval domain thread searches must be tagged origin=eval');
  });

  it('tags origin=user for non-eval threads (F192 server-side detection)', async () => {
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: {
        recall: async () => [],
        retain: async () => {},
        reflect: async () => '',
        ensureBank: async () => {},
        isHealthy: async () => true,
      },
      sharedBank: 'test',
      evidenceStore: mockStore(),
      knowledgeResolver: mockResolver(),
    });
    await app.ready();

    // Non-eval thread header — should remain origin=user
    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
      headers: { 'x-cat-cafe-thread-id': 'thread_abc12345' },
    });
    assert.equal(res.statusCode, 200);

    const userRow = db.prepare("SELECT origin FROM f163_logs WHERE log_type = 'search'").get();
    assert.ok(userRow, 'f163_logs must have a search entry');
    assert.equal(userRow.origin, 'user', 'non-eval thread searches must be tagged origin=user');
  });

  it('ignores spoofed currentThreadId query param for origin detection (F192 trust boundary)', async () => {
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: {
        recall: async () => [],
        retain: async () => {},
        reflect: async () => '',
        ensureBank: async () => {},
        isHealthy: async () => true,
      },
      sharedBank: 'test',
      evidenceStore: mockStore(),
      knowledgeResolver: mockResolver(),
    });
    await app.ready();

    // Spoof attempt: eval thread in query param but NO trusted header
    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&currentThreadId=thread_eval_spoof',
    });
    assert.equal(res.statusCode, 200);

    const row = db.prepare("SELECT origin FROM f163_logs WHERE log_type = 'search'").get();
    assert.ok(row, 'f163_logs must have a search entry');
    assert.equal(row.origin, 'user', 'spoofed query param must NOT grant eval exemption');
  });
});
