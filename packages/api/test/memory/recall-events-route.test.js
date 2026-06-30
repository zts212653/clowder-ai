/**
 * F102 bugfix regression: /api/recall/events route — thread ownership guard
 *
 * Verifies:
 * - 200: owner can read their thread's recall events
 * - 403: non-owner is blocked
 * - 404: non-existent thread returns 404
 * - 503: missing threadStore returns 503 (fail-closed)
 * - 400: missing threadId query param
 * - 401: missing auth header
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const AUTH_HEADER = { 'X-Cat-Cafe-User': 'user-owner' };

describe('GET /api/recall/events — F102 ownership guard', () => {
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
         abandoned, next_graph_resolve_after_read, token_cost, timestamp, thread_id, result_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Seed recall events in owned and system threads. The non-default system event
    // must not be readable just because the caller knows its threadId.
    insertRecallEvent.run(
      'r-1',
      'opus',
      'inv-1',
      'search_evidence',
      'F102',
      'hybrid',
      'docs',
      JSON.stringify([{ anchor: 'F102', docKind: 'feature' }]),
      '[]',
      0,
      0,
      0,
      0,
      0,
      1000,
      'thread-owned',
      1,
    );
    insertRecallEvent.run(
      'r-thread-results',
      'opus',
      'inv-thread-results',
      'search_evidence',
      'thread history',
      'hybrid',
      'threads',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      1003,
      'thread-owned',
      8,
    );
    insertRecallEvent.run(
      'r-oversized',
      'opus',
      'inv-oversized',
      'search_evidence',
      'oversized search',
      'hybrid',
      'threads',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      1004,
      'thread-owned',
      null,
    );
    insertRecallEvent.run(
      'r-list-recent',
      'opus',
      'inv-list-recent',
      'list_recent',
      '',
      null,
      'docs',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      1005,
      'thread-owned',
      3,
    );
    insertRecallEvent.run(
      'r-2',
      'codex',
      'inv-2',
      'search_evidence',
      'private-system-query',
      'hybrid',
      'docs',
      JSON.stringify([{ anchor: 'private-system-anchor', docKind: 'feature' }]),
      '[]',
      0,
      0,
      0,
      0,
      0,
      1001,
      'thread-system',
      1,
    );
    insertRecallEvent.run(
      'r-3',
      'codex',
      'inv-3',
      'search_evidence',
      'indexed-system-query',
      'hybrid',
      'docs',
      JSON.stringify([{ anchor: 'indexed-system-anchor', docKind: 'feature' }]),
      '[]',
      0,
      0,
      0,
      0,
      0,
      1002,
      'thread-indexed-system',
      1,
    );

    // Mock threadStore
    const threadStore = {
      async get(threadId) {
        if (threadId === 'default') return { id: 'default', createdBy: 'system' };
        if (threadId === 'thread-owned') return { id: 'thread-owned', createdBy: 'user-owner' };
        if (threadId === 'thread-system') return { id: 'thread-system', createdBy: 'system' };
        if (threadId === 'thread-indexed-system') return { id: 'thread-indexed-system', createdBy: 'system' };
        if (threadId === 'thread-other') return { id: 'thread-other', createdBy: 'user-other' };
        return null;
      },
      async list(userId) {
        if (userId === 'user-owner') {
          return [
            { id: 'default', createdBy: 'system' },
            { id: 'thread-owned', createdBy: 'user-owner' },
            { id: 'thread-indexed-system', createdBy: 'system' },
          ];
        }
        return [{ id: 'default', createdBy: 'system' }];
      },
    };

    app = Fastify({ logger: false });
    await app.register(recallMetricsRoutes, { evidenceDb: db, threadStore });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  it('200: owner gets their recall events', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 200, 'owner gets 200');
    const body = res.json();
    assert.ok(Array.isArray(body.events), 'events is an array');
    assert.equal(body.events.length, 4, 'four recall events');
    const docEvent = body.events.find((event) => event.query === 'F102');
    assert.ok(docEvent, 'doc event present');
    assert.equal(docEvent.toolName, 'search_evidence');
    assert.equal(docEvent.results[0].anchor, 'F102');
    assert.equal(docEvent.resultCount, 1);
  });

  it('200: returns toolName for query-less navigation events', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 200, 'owner gets 200');
    const body = res.json();
    const event = body.events.find((item) => item.id === 'r-list-recent');
    assert.ok(event, 'list_recent event present');
    assert.equal(event.query, '', 'list_recent has no query by design');
    assert.equal(event.toolName, 'list_recent');
    assert.equal(event.scope, 'docs');
    assert.equal(event.resultCount, 3);
  });

  it('200: returns reported hit count even when no candidate anchors were persisted', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 200, 'owner gets 200');
    const body = res.json();
    const event = body.events.find((item) => item.query === 'thread history');
    assert.ok(event, 'thread-scope recall event present');
    assert.equal(event.resultCount, 8, 'reported Found N count survives candidates_json=[]');
    assert.deepEqual(event.results, [], 'no fake candidate rows are invented');
  });

  it('200: omits resultCount when historical rows have neither reported count nor candidates', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 200, 'owner gets 200');
    const body = res.json();
    const event = body.events.find((item) => item.query === 'oversized search');
    assert.ok(event, 'oversized recall event present');
    assert.equal('resultCount' in event, false, 'unknown count must not be displayed as 0');
    assert.deepEqual(event.results, []);
  });

  it('200: default system thread is accessible by any user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=default',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 200, 'default system thread accessible');
  });

  it('403: non-default system thread is blocked when it is not indexed for the user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-system',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 403, 'non-default system thread is not globally public');
    const body = res.json();
    assert.equal(body.error, 'Forbidden');
  });

  it('200: non-default system thread is accessible when indexed for the user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-indexed-system',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 200, 'indexed system thread accessible');
    const body = res.json();
    assert.equal(body.events.length, 1, 'one indexed recall event');
    assert.equal(body.events[0].query, 'indexed-system-query');
  });

  it('403: non-owner is blocked', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-other',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 403, 'non-owner gets 403');
    const body = res.json();
    assert.equal(body.error, 'Forbidden');
  });

  it('404: non-existent thread', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-nonexistent',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 404, 'missing thread gets 404');
  });

  it('400: missing threadId query param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 400, 'missing threadId gets 400');
  });

  it('401: missing auth header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned',
    });
    assert.equal(res.statusCode, 401, 'no auth gets 401');
  });
});

describe('GET /api/recall/events — fail-closed without threadStore', () => {
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
      url: '/api/recall/events?threadId=thread-any',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 503, 'missing threadStore returns 503');
    const body = res.json();
    assert.equal(body.error, 'Thread store unavailable');
  });
});
