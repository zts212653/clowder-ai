import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

describe('QueryReplayCompare (AC-E2)', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS f163_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_type TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        effective_flags TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => {
    if (db) db.close();
  });

  function insertCapture(payload) {
    db.prepare('INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload) VALUES (?, ?, ?, ?)').run(
      'search',
      'v1',
      '{}',
      JSON.stringify(payload),
    );
    return db.prepare('SELECT last_insert_rowid() as id').get().id;
  }

  function mockResolver(replayGroups) {
    return {
      resolve: async () => ({
        results: replayGroups.flatMap((g) => g.items),
        sources: ['project'],
        query: 'test',
        collectionGroups: replayGroups,
      }),
    };
  }

  it('replays captured query and returns per-collection diff + Jaccard', async () => {
    const captureId = insertCapture({
      query: 'lore',
      resultCount: 3,
      scope: 'docs',
      dimension: 'library',
      collections: ['world:lexander', 'project:cat-cafe'],
      topKPerCollection: {
        'world:lexander': { count: 2, anchors: ['world:lexander:doc/a', 'world:lexander:doc/b'] },
        'project:cat-cafe': { count: 1, anchors: ['project:cat-cafe:doc/f186'] },
      },
    });

    const resolver = mockResolver([
      {
        collectionId: 'world:lexander',
        sensitivity: 'private',
        status: 'ok',
        durationMs: 3,
        items: [
          { anchor: 'world:lexander:doc/a', kind: 'lore', status: 'active', title: 'A', updatedAt: '2026-01-01' },
          { anchor: 'world:lexander:doc/c', kind: 'lore', status: 'active', title: 'C', updatedAt: '2026-01-01' },
        ],
      },
      {
        collectionId: 'project:cat-cafe',
        sensitivity: 'internal',
        status: 'ok',
        durationMs: 2,
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
    ]);

    const { QueryReplayCompare } = await import('../../dist/domains/memory/QueryReplayCompare.js');
    const compare = new QueryReplayCompare(db);
    const result = await compare.replay(captureId, resolver);

    // Structure
    assert.equal(result.captureId, captureId);
    assert.equal(result.query, 'lore');
    assert.deepEqual(result.params, {
      scope: 'docs',
      dimension: 'library',
      collections: ['world:lexander', 'project:cat-cafe'],
    });

    // Per-collection: world:lexander — captured [a, b], replayed [a, c]
    const wl = result.perCollection.find((c) => c.collectionId === 'world:lexander');
    assert.ok(wl);
    assert.equal(wl.captured, 2);
    assert.equal(wl.replayed, 2);
    assert.deepEqual(wl.overlap, ['world:lexander:doc/a']);
    assert.deepEqual(wl.added, ['world:lexander:doc/c']);
    assert.deepEqual(wl.removed, ['world:lexander:doc/b']);

    // Per-collection: project:cat-cafe — captured [f186], replayed [f186]
    const pc = result.perCollection.find((c) => c.collectionId === 'project:cat-cafe');
    assert.ok(pc);
    assert.equal(pc.captured, 1);
    assert.equal(pc.replayed, 1);
    assert.deepEqual(pc.overlap, ['project:cat-cafe:doc/f186']);
    assert.deepEqual(pc.added, []);
    assert.deepEqual(pc.removed, []);

    // Aggregated Jaccard: intersection={a, f186}=2, union={a, b, c, f186}=4 → 0.5
    assert.deepEqual(result.aggregated.capturedAnchors.sort(), [
      'project:cat-cafe:doc/f186',
      'world:lexander:doc/a',
      'world:lexander:doc/b',
    ]);
    assert.deepEqual(result.aggregated.replayedAnchors.sort(), [
      'project:cat-cafe:doc/f186',
      'world:lexander:doc/a',
      'world:lexander:doc/c',
    ]);
    assert.equal(result.aggregated.jaccardSimilarity, 0.5);
  });

  it('passes captured limit to resolver during replay', async () => {
    const captureId = insertCapture({
      query: 'bounded',
      resultCount: 2,
      limit: 3,
      scope: 'docs',
      collections: ['project:cat-cafe'],
      topKPerCollection: {
        'project:cat-cafe': { count: 2, anchors: ['project:cat-cafe:doc/a', 'project:cat-cafe:doc/b'] },
      },
    });

    let capturedOptions = null;
    const resolver = {
      resolve: async (query, options) => {
        capturedOptions = options;
        return {
          results: [],
          sources: ['project'],
          query,
          collectionGroups: [
            {
              collectionId: 'project:cat-cafe',
              sensitivity: 'internal',
              status: 'ok',
              durationMs: 1,
              items: [
                {
                  anchor: 'project:cat-cafe:doc/a',
                  kind: 'feature',
                  status: 'active',
                  title: 'A',
                  updatedAt: '2026-01-01',
                },
              ],
            },
          ],
        };
      },
    };

    const { QueryReplayCompare } = await import('../../dist/domains/memory/QueryReplayCompare.js');
    const compare = new QueryReplayCompare(db);
    await compare.replay(captureId, resolver);

    assert.ok(capturedOptions, 'resolver.resolve should have been called');
    assert.equal(capturedOptions.limit, 3, 'captured limit must be forwarded to resolver');
  });

  it('throws for non-existent captureId', async () => {
    const { QueryReplayCompare } = await import('../../dist/domains/memory/QueryReplayCompare.js');
    const compare = new QueryReplayCompare(db);
    await assert.rejects(() => compare.replay(999, { resolve: async () => ({}) }), /not found/);
  });

  it('handles collections not present in replay', async () => {
    const captureId = insertCapture({
      query: 'gone',
      resultCount: 1,
      scope: 'docs',
      collections: ['world:lexander'],
      topKPerCollection: {
        'world:lexander': { count: 1, anchors: ['world:lexander:doc/x'] },
      },
    });

    const resolver = mockResolver([]);

    const { QueryReplayCompare } = await import('../../dist/domains/memory/QueryReplayCompare.js');
    const compare = new QueryReplayCompare(db);
    const result = await compare.replay(captureId, resolver);

    // Collection from capture not in replay → all removed
    const wl = result.perCollection.find((c) => c.collectionId === 'world:lexander');
    assert.ok(wl);
    assert.equal(wl.captured, 1);
    assert.equal(wl.replayed, 0);
    assert.deepEqual(wl.overlap, []);
    assert.deepEqual(wl.added, []);
    assert.deepEqual(wl.removed, ['world:lexander:doc/x']);

    assert.equal(result.aggregated.jaccardSimilarity, 0);
  });

  it('rejects legacy capture without topKPerCollection anchors', async () => {
    const captureId = insertCapture({
      query: 'old query',
      resultCount: 5,
    });

    const resolver = mockResolver([]);

    const { QueryReplayCompare } = await import('../../dist/domains/memory/QueryReplayCompare.js');
    const compare = new QueryReplayCompare(db);
    await assert.rejects(() => compare.replay(captureId, resolver), /unsupported capture format/i);
  });

  it('rejects empty topKPerCollection object', async () => {
    const captureId = insertCapture({
      query: 'empty collections',
      resultCount: 0,
      topKPerCollection: {},
    });

    const resolver = mockResolver([]);

    const { QueryReplayCompare } = await import('../../dist/domains/memory/QueryReplayCompare.js');
    const compare = new QueryReplayCompare(db);
    await assert.rejects(() => compare.replay(captureId, resolver), /unsupported capture format/i);
  });

  it('rejects count-only topKPerCollection (no anchors array)', async () => {
    const captureId = insertCapture({
      query: 'count only',
      resultCount: 2,
      topKPerCollection: { 'world:lexander': 2 },
    });

    const resolver = mockResolver([]);

    const { QueryReplayCompare } = await import('../../dist/domains/memory/QueryReplayCompare.js');
    const compare = new QueryReplayCompare(db);
    await assert.rejects(() => compare.replay(captureId, resolver), /unsupported capture format/i);
  });
});

describe('POST /api/f163/query-replay endpoint (AC-E2)', () => {
  let app;
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS f163_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_type TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        effective_flags TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) db.close();
  });

  function insertCapture(payload) {
    db.prepare('INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload) VALUES (?, ?, ?, ?)').run(
      'search',
      'v1',
      '{}',
      JSON.stringify(payload),
    );
    return db.prepare('SELECT last_insert_rowid() as id').get().id;
  }

  it('returns replay result via POST endpoint', async () => {
    const captureId = insertCapture({
      query: 'test',
      resultCount: 1,
      scope: 'docs',
      collections: ['project:cat-cafe'],
      topKPerCollection: {
        'project:cat-cafe': { count: 1, anchors: ['project:cat-cafe:doc/f186'] },
      },
    });

    const mockResolver = {
      resolve: async () => ({
        results: [
          {
            anchor: 'project:cat-cafe:doc/f186',
            kind: 'feature',
            status: 'active',
            title: 'F186',
            updatedAt: '2026-01-01',
          },
        ],
        sources: ['project'],
        query: 'test',
        collectionGroups: [
          {
            collectionId: 'project:cat-cafe',
            sensitivity: 'internal',
            status: 'ok',
            durationMs: 2,
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

    const mockStore = {
      search: async () => [],
      getByAnchor: async () => null,
      getDb: () => db,
      runExclusive: async (fn) => fn(),
    };

    const { f163AuditRoutes } = await import('../../dist/routes/f163-audit-routes.js');
    app = Fastify();
    await app.register(f163AuditRoutes, { evidenceStore: mockStore, knowledgeResolver: mockResolver });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/query-replay',
      payload: { captureId },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.captureId, captureId);
    assert.equal(body.query, 'test');
    assert.equal(body.aggregated.jaccardSimilarity, 1);
  });

  it('returns 400 for missing captureId', async () => {
    const mockStore = {
      search: async () => [],
      getByAnchor: async () => null,
      getDb: () => db,
      runExclusive: async (fn) => fn(),
    };

    const { f163AuditRoutes } = await import('../../dist/routes/f163-audit-routes.js');
    app = Fastify();
    await app.register(f163AuditRoutes, { evidenceStore: mockStore, knowledgeResolver: { resolve: async () => ({}) } });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/query-replay',
      payload: {},
    });

    assert.equal(res.statusCode, 400);
  });

  it('returns 404 for non-existent captureId', async () => {
    const mockStore = {
      search: async () => [],
      getByAnchor: async () => null,
      getDb: () => db,
      runExclusive: async (fn) => fn(),
    };

    const { f163AuditRoutes } = await import('../../dist/routes/f163-audit-routes.js');
    app = Fastify();
    await app.register(f163AuditRoutes, { evidenceStore: mockStore, knowledgeResolver: { resolve: async () => ({}) } });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/query-replay',
      payload: { captureId: 999 },
    });

    assert.equal(res.statusCode, 404);
  });

  it('returns 422 for legacy capture without anchors', async () => {
    const captureId = db
      .prepare('INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload) VALUES (?, ?, ?, ?)')
      .run('search', 'v1', '{}', JSON.stringify({ query: 'old', resultCount: 3 })).lastInsertRowid;

    const mockStore = {
      search: async () => [],
      getByAnchor: async () => null,
      getDb: () => db,
      runExclusive: async (fn) => fn(),
    };

    const { f163AuditRoutes } = await import('../../dist/routes/f163-audit-routes.js');
    app = Fastify();
    await app.register(f163AuditRoutes, { evidenceStore: mockStore, knowledgeResolver: { resolve: async () => ({}) } });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/query-replay',
      payload: { captureId: Number(captureId) },
    });

    assert.equal(res.statusCode, 422);
    assert.ok(res.json().error.includes('Unsupported capture format'));
  });
});
