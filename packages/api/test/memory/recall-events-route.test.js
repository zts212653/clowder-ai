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
         abandoned, next_graph_resolve_after_read, token_cost, timestamp, thread_id, result_count, result_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      'counted',
    );
    db.prepare(
      `UPDATE recall_events
       SET source = 'push', push_surface = 'session_bootstrap', presented = 1,
           inspected = 1, outcome = 'used'
       WHERE recall_id = 'r-1'`,
    ).run();
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
      'counted',
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
      'overflow',
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
      'counted',
    );
    insertRecallEvent.run(
      'r-legacy-candidates',
      'opus',
      'inv-legacy-candidates',
      'search_evidence',
      'legacy candidates only',
      'hybrid',
      'docs',
      JSON.stringify([{ anchor: 'LEGACY-1', docKind: 'feature' }]),
      '[]',
      0,
      0,
      0,
      0,
      0,
      1006,
      'thread-owned',
      null,
      null,
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
      'counted',
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
      'counted',
    );

    // F263: seed a recall event with mixed consumed_json (one consumed, one not)
    insertRecallEvent.run(
      'r-mixed-consumed',
      'opus',
      'inv-mixed',
      'search_evidence',
      'mixed consumed',
      'hybrid',
      'docs',
      JSON.stringify([
        { anchor: 'anchor-consumed', docKind: 'feature' },
        { anchor: 'anchor-ignored', docKind: 'feedback' },
      ]),
      JSON.stringify([{ anchor: 'anchor-consumed', rank: 1, method: 'shell_read' }]),
      0,
      0,
      0,
      0,
      0,
      1007,
      'thread-owned',
      2,
      'counted',
    );
    db.prepare(
      `UPDATE recall_events
       SET source = 'pull', presented = 1, inspected = 1, outcome = 'used'
       WHERE recall_id = 'r-mixed-consumed'`,
    ).run();

    db.prepare(`INSERT INTO evidence_docs (anchor, kind, status, title, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
      'F102',
      'feature',
      'active',
      'Memory Adapter',
      '2026-10-02',
    );
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, collection_id, world_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'LEGACY-1',
      'feature',
      'active',
      'private title must stay private',
      '2026-10-02',
      'private-library',
      'private-world',
    );
    // Mock threadStore
    const threadStore = {
      async get(threadId) {
        if (threadId === 'default') return { id: 'default', createdBy: 'system' };
        if (threadId === 'thread-owned') return { id: 'thread-owned', createdBy: 'user-owner', title: '当前对话标题' };
        if (threadId === 'thread-system') return { id: 'thread-system', createdBy: 'system' };
        if (threadId === 'thread-indexed-system') return { id: 'thread-indexed-system', createdBy: 'system' };
        if (threadId === 'thread-other')
          return { id: 'thread-other', createdBy: 'user-other', title: '外部主人私有标题' };
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
    await app.register(recallMetricsRoutes, {
      evidenceDb: db,
      threadStore,
      messageStore: {
        getByThreadBefore(threadId, timestamp, limit, beforeId, userId) {
          assert.equal(threadId, 'thread-owned');
          assert.equal(timestamp, 12);
          assert.equal(limit, 500);
          assert.equal(beforeId, 'reply-1');
          assert.equal(userId, 'user-owner');
          return [
            {
              id: 'reply-old',
              catId: 'opus',
              content: 'old private body',
              timestamp: 1,
              extra: { stream: { invocationId: 'parent-old', turnInvocationId: 'turn-old' } },
            },
          ];
        },
        getByThread(threadId, limit, userId) {
          assert.ok(['thread-owned', 'default', 'thread-indexed-system'].includes(threadId));
          assert.equal(limit, 500);
          assert.equal(userId, 'user-owner');
          return [
            {
              id: 'reply-1',
              type: 'assistant',
              catId: 'opus',
              content: 'do not return this body',
              timestamp: 12,
              extra: { stream: { invocationId: 'inv-1', turnInvocationId: 'turn-1' } },
            },
          ];
        },
      },
    });
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
    assert.equal(body.events.length, 6, 'six recall events');
    const docEvent = body.events.find((event) => event.query === 'F102');
    assert.ok(docEvent, 'doc event present');
    assert.equal(docEvent.toolName, 'search_evidence');
    assert.equal(docEvent.catId, 'opus');
    assert.equal(docEvent.invocationId, 'inv-1');
    assert.equal(docEvent.consumedCount, 0);
    assert.deepEqual(body.replies, [
      { messageId: 'reply-1', catId: 'opus', invocationId: 'turn-1', parentInvocationId: 'inv-1', timestamp: 12 },
    ]);
    assert.equal(JSON.stringify(body).includes('do not return this body'), false);
    assert.equal(docEvent.results[0].anchor, 'F102');
    assert.equal(docEvent.results[0].title, 'Memory Adapter');
    assert.equal(docEvent.results[0].consumed, false, 'consumed_json is empty so consumed=false');
    assert.equal(docEvent.resultCount, 1);
    assert.equal(docEvent.resultStatus, 'counted');
    assert.equal(docEvent.source, 'push');
    assert.equal(docEvent.pushSurface, 'session_bootstrap');
    assert.equal(docEvent.presented, true);
    assert.equal(docEvent.inspected, true);
    assert.equal(docEvent.outcome, 'used');
  });

  it('cue invocation discovery is scoped to both owner and thread', async () => {
    const insert = db.prepare(`INSERT INTO memory_cue_events
      (event_id, idempotency_key, cue_id, opportunity_id, owner_user_id, thread_id, invocation_id,
       consumer_cat_id, resolver_family, source_anchor, source_revision, axis, consumption_outcome,
       catalog_version, resolver_version, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'opus', 'taste', 'taste-source', 'r1', 'consumption', 'presented', 1, 1, 100, '2026-10-02')`);
    for (const [id, owner, thread] of [
      ['mine', 'user-owner', 'thread-owned'],
      ['another-owner', 'user-other', 'thread-owned'],
      ['another-thread', 'user-owner', 'thread-other'],
    ]) {
      insert.run(id, id, id, id, owner, thread, id);
    }
    const response = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned',
      headers: AUTH_HEADER,
    });
    assert.deepEqual(response.json().cueInvocationIds, ['mine']);
  });

  it('returns readable plan titles through the authenticated recall route', async () => {
    db.prepare('INSERT INTO evidence_docs (anchor, kind, status, title, updated_at) VALUES (?,?,?,?,?)').run(
      'doc:plan',
      'plan',
      'active',
      '真实计划',
      '2026-10-02',
    );
    db.prepare('UPDATE recall_events SET candidates_json = ? WHERE recall_id = ?').run(
      JSON.stringify([{ anchor: 'doc:plan', docKind: 'plan' }]),
      'r-thread-results',
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned',
      headers: AUTH_HEADER,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().events.find((event) => event.id === 'r-thread-results').results[0], {
      title: '真实计划',
      href: '/memory/search?q=doc%3Aplan',
      sourceType: 'plan',
      anchor: 'doc:plan',
      consumed: false,
    });
  });

  it('resolves only accessible source titles and exports explicit destinations', async () => {
    db.prepare('UPDATE recall_events SET candidates_json = ? WHERE recall_id = ?').run(
      JSON.stringify([
        { anchor: 'thread-thread-owned', docKind: 'phase' },
        { anchor: 'thread-thread-other', docKind: 'phase' },
      ]),
      'r-thread-results',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned',
      headers: AUTH_HEADER,
    });
    const body = res.json();
    assert.deepEqual(
      body.sourceViews.find((view) => view.anchor === 'thread-thread-owned'),
      { anchor: 'thread-thread-owned', kind: 'thread', title: '当前对话标题', href: '/thread/thread-owned' },
    );
    assert.deepEqual(
      body.sourceViews.find((view) => view.anchor === 'thread-thread-other'),
      { anchor: 'thread-thread-other', kind: 'thread', href: null },
    );
    assert.equal(JSON.stringify(body).includes('外部主人私有标题'), false);
    assert.deepEqual(
      body.events
        .find((event) => event.id === 'r-thread-results')
        .results.map((item) => [item.title, item.sourceType, item.href]),
      [
        ['当前对话标题', 'thread', '/thread/thread-owned'],
        ['', 'thread', null],
      ],
    );
  });

  it('reads older reply coordinates through the same thread and owner boundary', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned&replyBeforeTs=12&replyBeforeId=reply-1',
      headers: AUTH_HEADER,
    });
    assert.deepEqual(res.json().replies, [
      {
        messageId: 'reply-old',
        catId: 'opus',
        invocationId: 'turn-old',
        parentInvocationId: 'parent-old',
        timestamp: 1,
      },
    ]);
  });
  it('rejects malformed reply pagination without reading an unrelated page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned&replyBeforeTs=bad&replyBeforeId=reply-1',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 400);
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
    assert.equal(event.resultStatus, 'counted');
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
    assert.equal(event.resultStatus, 'counted');
    assert.deepEqual(event.results, [], 'no fake candidate rows are invented');
  });

  it('200: preserves explicit resultStatus when historical rows have no count', async () => {
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
    assert.equal(event.resultStatus, 'overflow');
    assert.deepEqual(event.results, []);
  });

  it('200: legacy candidate rows do not report candidate count as recorded hit count', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 200, 'owner gets 200');
    const body = res.json();
    const event = body.events.find((item) => item.id === 'r-legacy-candidates');
    assert.ok(event, 'legacy candidate event present');
    assert.equal(event.resultStatus, 'legacy_unknown');
    assert.equal('resultCount' in event, false, 'candidate anchors are not recorded hit counts');
    assert.deepEqual(event.results, [
      { title: '', href: null, anchor: 'LEGACY-1', sourceType: 'feature', consumed: false },
    ]);
  });

  it('200: mixed consumed_json marks consumed candidates correctly', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/recall/events?threadId=thread-owned',
      headers: AUTH_HEADER,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const event = body.events.find((item) => item.id === 'r-mixed-consumed');
    assert.ok(event, 'mixed-consumed event present');
    assert.equal(event.results.length, 2, 'two candidates');
    const consumedResult = event.results.find((r) => r.anchor === 'anchor-consumed');
    const ignoredResult = event.results.find((r) => r.anchor === 'anchor-ignored');
    assert.equal(consumedResult.consumed, true, 'consumed candidate marked true');
    assert.equal(ignoredResult.consumed, false, 'unconsumed candidate marked false');
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
