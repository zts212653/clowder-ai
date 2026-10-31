/**
 * F263 B.5 Task 4: /api/recall/ledger — consumption ledger aggregate
 *
 * Verifies:
 * - 200: returns grouped push/pull rows with correct aggregates (scoped to user threads)
 * - invariant: 0 <= used <= inspected <= presented
 * - foreign-thread events excluded from aggregates
 * - empty range returns rows=[]
 * - 401: missing auth header
 * - 503: missing threadStore (fail-closed)
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const AUTH_HEADER = { 'X-Cat-Cafe-User': 'user-owner' };
const NOW = Date.now();

describe('GET /api/recall/ledger — F263 B.5 consumption ledger', () => {
  let app;
  let db;

  beforeEach(async () => {
    const Database = (await import('better-sqlite3')).default;
    const Fastify = (await import('fastify')).default;
    const schema = await import('../../dist/domains/memory/schema.js');
    const { recallMetricsRoutes } = await import(`../../dist/routes/recall-metrics.js?v=${Date.now()}`);

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(schema.SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    schema.applyMigrations(db);

    const insertRecallEvent = db.prepare(
      `INSERT INTO recall_events
        (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
         candidates_json, consumed_json, reformulated, fell_back_to_grep,
         abandoned, next_graph_resolve_after_read, token_cost, timestamp,
         thread_id, result_count, result_status, source, push_surface,
         presented, inspected, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Seed: 3 push events in thread-owned (2 session_bootstrap, 1 cold_context)
    insertRecallEvent.run(
      'r-push-1',
      'opus',
      'inv-1',
      'session_bootstrap',
      '',
      null,
      null,
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      NOW - 1000,
      'thread-owned',
      5,
      'counted',
      'push',
      'session_bootstrap',
      1,
      1,
      'used',
    );
    insertRecallEvent.run(
      'r-push-2',
      'opus',
      'inv-2',
      'session_bootstrap',
      '',
      null,
      null,
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      NOW - 2000,
      'thread-owned',
      5,
      'counted',
      'push',
      'session_bootstrap',
      1,
      0,
      null,
    );
    insertRecallEvent.run(
      'r-push-3',
      'opus',
      'inv-3',
      'cold_context',
      '',
      null,
      null,
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      NOW - 3000,
      'thread-owned',
      2,
      'counted',
      'push',
      'cold_context',
      1,
      0,
      null,
    );

    // Seed: 2 pull events in thread-owned (search_evidence)
    insertRecallEvent.run(
      'r-pull-1',
      'opus',
      'inv-4',
      'search_evidence',
      'F263',
      'hybrid',
      'docs',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      NOW - 4000,
      'thread-owned',
      3,
      'counted',
      'pull',
      null,
      1,
      1,
      'used',
    );
    insertRecallEvent.run(
      'r-pull-2',
      'opus',
      'inv-5',
      'search_evidence',
      'F200',
      'lexical',
      'docs',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      NOW - 5000,
      'thread-owned',
      2,
      'counted',
      'pull',
      null,
      1,
      0,
      null,
    );

    // Seed: 1 old event outside 7-day window (in thread-owned)
    insertRecallEvent.run(
      'r-old',
      'opus',
      'inv-6',
      'search_evidence',
      'old',
      'hybrid',
      'docs',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      NOW - 8 * 24 * 60 * 60 * 1000,
      'thread-owned',
      1,
      'counted',
      'pull',
      null,
      1,
      1,
      'used',
    );

    // Seed: 1 event in FOREIGN thread (should be excluded from user-owner results)
    insertRecallEvent.run(
      'r-foreign',
      'opus',
      'inv-7',
      'search_evidence',
      'secret',
      'hybrid',
      'docs',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      NOW - 500,
      'thread-foreign',
      1,
      'counted',
      'pull',
      null,
      1,
      1,
      'used',
    );

    // Mock threadStore — user-owner owns thread-owned but NOT thread-foreign
    const threadStore = {
      async get(threadId) {
        if (threadId === 'thread-owned') return { id: 'thread-owned', createdBy: 'user-owner' };
        if (threadId === 'thread-foreign') return { id: 'thread-foreign', createdBy: 'user-other' };
        return null;
      },
      async list(userId) {
        if (userId === 'user-owner') return [{ id: 'thread-owned', createdBy: 'user-owner' }];
        return [];
      },
    };

    app = Fastify();
    await app.register(recallMetricsRoutes, { evidenceDb: db, threadStore });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  it('returns grouped rows scoped to user threads for 7 days', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recall/ledger?days=7', headers: AUTH_HEADER });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);

    assert.equal(body.days, 7);
    assert.ok(body.from > 0);
    assert.ok(body.to > body.from);
    assert.ok(Array.isArray(body.rows));

    // Should have 3 groups: push/session_bootstrap, push/cold_context, pull/search_evidence
    // Foreign-thread event must NOT be included
    assert.equal(body.rows.length, 3);

    const pushBootstrap = body.rows.find((r) => r.source === 'push' && r.surface === 'session_bootstrap');
    assert.ok(pushBootstrap, 'should have push/session_bootstrap row');
    assert.equal(pushBootstrap.presented, 2);
    assert.equal(pushBootstrap.inspected, 1);
    assert.equal(pushBootstrap.used, 1);

    const pushCold = body.rows.find((r) => r.source === 'push' && r.surface === 'cold_context');
    assert.ok(pushCold, 'should have push/cold_context row');
    assert.equal(pushCold.presented, 1);
    assert.equal(pushCold.inspected, 0);
    assert.equal(pushCold.used, 0);

    const pullSearch = body.rows.find((r) => r.source === 'pull' && r.surface === 'search_evidence');
    assert.ok(pullSearch, 'should have pull/search_evidence row');
    // Only 2 pull events in thread-owned within 7d (r-pull-1, r-pull-2), NOT r-foreign
    assert.equal(pullSearch.presented, 2);
    assert.equal(pullSearch.inspected, 1);
    assert.equal(pullSearch.used, 1);
  });

  it('foreign-thread events excluded from aggregates', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recall/ledger?days=7', headers: AUTH_HEADER });
    const body = JSON.parse(res.payload);

    // The foreign event (r-foreign) has presented=1. If it leaked through,
    // pull/search_evidence.presented would be 3 instead of 2.
    const pullSearch = body.rows.find((r) => r.source === 'pull' && r.surface === 'search_evidence');
    assert.equal(pullSearch.presented, 2, 'foreign-thread event must not be included');
  });

  it('invariant: 0 <= used <= inspected <= presented for every row', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recall/ledger?days=30', headers: AUTH_HEADER });
    const body = JSON.parse(res.payload);

    for (const row of body.rows) {
      assert.ok(row.used >= 0, `used >= 0 for ${row.surface}`);
      assert.ok(row.used <= row.inspected, `used <= inspected for ${row.surface}`);
      assert.ok(row.inspected <= row.presented, `inspected <= presented for ${row.surface}`);
    }
  });

  it('old event excluded from 7-day window but included in 30-day', async () => {
    const res7 = await app.inject({ method: 'GET', url: '/api/recall/ledger?days=7', headers: AUTH_HEADER });
    const body7 = JSON.parse(res7.payload);
    const pull7 = body7.rows.find((r) => r.source === 'pull');
    assert.equal(pull7.presented, 2, 'old event excluded from 7d');

    const res30 = await app.inject({ method: 'GET', url: '/api/recall/ledger?days=30', headers: AUTH_HEADER });
    const body30 = JSON.parse(res30.payload);
    const pull30 = body30.rows.find((r) => r.source === 'pull');
    assert.equal(pull30.presented, 3, 'old event included in 30d');
  });

  it('user with no threads gets empty rows and respects days param', async () => {
    // Query as user-other who has no threads in the mock
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/ledger?days=30',
      headers: { 'X-Cat-Cafe-User': 'user-other' },
    });
    const body = JSON.parse(res.payload);
    assert.equal(res.statusCode, 200);
    assert.equal(body.days, 30, 'days param must be respected even when no visible threads');
    assert.deepEqual(body.rows, []);
  });

  it('returns 401 without auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recall/ledger?days=7' });
    assert.equal(res.statusCode, 401);
  });
});

describe('GET /api/recall/ledger — fail-closed without threadStore', () => {
  let app;
  let db;

  beforeEach(async () => {
    const Database = (await import('better-sqlite3')).default;
    const Fastify = (await import('fastify')).default;
    const schema = await import('../../dist/domains/memory/schema.js');
    const { recallMetricsRoutes } = await import(`../../dist/routes/recall-metrics.js?v=${Date.now()}`);

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(schema.SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    schema.applyMigrations(db);

    // Register WITHOUT threadStore — should fail-closed
    app = Fastify({ logger: false });
    await app.register(recallMetricsRoutes, { evidenceDb: db });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  it('503: no threadStore = service unavailable (fail-closed)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/ledger?days=7',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 503, 'missing threadStore returns 503');
    const body = JSON.parse(res.payload);
    assert.equal(body.error, 'Thread store unavailable');
  });
});
