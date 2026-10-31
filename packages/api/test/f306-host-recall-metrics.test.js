import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { CANONICAL_TOOL_REGISTRY } from '../../mcp-server/dist/canonical-server-tools.js';
import { createServer } from '../../mcp-server/dist/index.js';
import { useInvocationAuth } from '../../mcp-server/test/helpers/invocation-auth.js';
import { applyMigrations, SCHEMA_V1 } from '../dist/domains/memory/schema.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackMemoryRoutes } from '../dist/routes/callback-memory-routes.js';
import { clearRecallMetricsCache, recallMetricsRoutes } from '../dist/routes/recall-metrics.js';

describe('F306 named Host recall metrics', () => {
  let app;
  let db;
  let observed;
  let policy;
  let rewriteReport;
  let databaseRoot;
  const credentials = { 'x-invocation-id': 'metrics-inv', 'x-callback-token': 'metrics-token' };

  beforeEach(async () => {
    clearRecallMetricsCache();
    databaseRoot = await mkdtemp(join(tmpdir(), 'f306-metrics-entry-'));
    db = new Database(join(databaseRoot, 'evidence.sqlite'));
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (1, ?)').run(new Date().toISOString());
    applyMigrations(db);
    db.prepare(`INSERT INTO recall_events
      (recall_id, cat_id, invocation_id, tool_name, query, mode, scope, candidates_json,
       consumed_json, reformulated, fell_back_to_grep, abandoned, next_graph_resolve_after_read,
       token_cost, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`).run(
      'metrics-event',
      'codex61-sol',
      'metrics-inv',
      'cat_cafe_search_evidence',
      'private query',
      'hybrid',
      'docs',
      '[{"anchor":"A"}]',
      '[{"anchor":"A","rank":0}]',
      Date.now(),
    );
    observed = [];
    policy = undefined;
    rewriteReport = undefined;
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      if (request.url.startsWith('/api/recall/metrics'))
        observed.push({ method: request.method, url: request.url, actor: request.headers['x-cat-cafe-user'] });
    });
    app.addHook('onSend', async (request, _reply, payload) => {
      if (rewriteReport && request.url.startsWith('/api/recall/metrics'))
        return JSON.stringify(rewriteReport(JSON.parse(payload)));
      return payload;
    });
    registerCallbackAuthHook(app, {
      verify: async (id, token) =>
        id === 'metrics-inv' && token === 'metrics-token'
          ? {
              ok: true,
              record: {
                invocationId: id,
                callbackToken: token,
                userId: 'default-user',
                catId: 'codex61-sol',
                threadId: 'metrics-thread',
                toolExecutionPolicy: policy,
              },
            }
          : { ok: false, reason: 'invalid_token' },
      agentKeyRegistry: {
        verify: async () => ({
          ok: true,
          record: {
            agentKeyId: 'ak-metrics-test',
            catId: 'codex61-sol',
            userId: 'default-user',
            secretHash: 'fixture',
            salt: 'fixture',
            scope: 'user-bound',
            issuedAt: Date.now(),
            expiresAt: Date.now() + 10000,
          },
        }),
      },
    });
    await app.register(recallMetricsRoutes, { evidenceDb: db });
    await registerCallbackMemoryRoutes(app, {});
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
    await rm(databaseRoot, { recursive: true, force: true });
    clearRecallMetricsCache();
  });

  it('registered callback returns the same aggregate as the canonical GET, using the verified actor', async () => {
    const original = await app.inject({
      method: 'GET',
      url: '/api/recall/metrics?days=30',
      headers: { 'x-cat-cafe-user': 'default-user' },
    });
    assert.equal(original.statusCode, 200);
    const before = db.prepare('SELECT total_changes() AS n').get().n;
    observed.length = 0;
    const result = await app.inject({
      method: 'GET',
      url: '/api/callbacks/get-recall-metrics?days=30',
      headers: { ...credentials, 'x-cat-cafe-user': 'forged-user' },
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), original.json());
    assert.deepEqual(observed, [{ method: 'GET', url: '/api/recall/metrics?days=30', actor: 'default-user' }]);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
    assert.equal(JSON.stringify(result.json()).includes('private query'), false);
  });

  it('rejects invalid credentials before accessing metrics', async () => {
    const result = await app.inject({
      method: 'GET',
      url: '/api/callbacks/get-recall-metrics',
      headers: { ...credentials, 'x-callback-token': 'expired' },
    });
    assert.equal(result.statusCode, 401);
    assert.deepEqual(observed, []);
  });

  it('requires invocation auth even with a forged public-route actor', async () => {
    const result = await app.inject({
      method: 'GET',
      url: '/api/callbacks/get-recall-metrics',
      headers: { 'x-cat-cafe-user': 'default-user' },
    });
    assert.equal(result.statusCode, 401);
    assert.deepEqual(observed, []);
  });

  it('rejects aggregate metadata that does not match the requested filters or window', async () => {
    for (rewriteReport of [
      (report) => ({ ...report, filters: { catId: 'different' } }),
      (report) => ({ ...report, period: { ...report.period, days: 90 } }),
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/callbacks/get-recall-metrics?days=30&catId=a',
        headers: credentials,
      });
      assert.equal(response.statusCode, 502);
    }
  });

  it('does not expand agent-key or scoped callback admission', async () => {
    const agent = await app.inject({
      method: 'GET',
      url: '/api/callbacks/get-recall-metrics',
      headers: { 'x-agent-key-secret': 'fixture-agent-key' },
    });
    assert.equal(agent.statusCode, 401);
    policy = { mode: 'callback_allowlist', allowedCallbackRoutes: ['GET /api/callbacks/search-evidence'] };
    const denied = await app.inject({ method: 'GET', url: '/api/callbacks/get-recall-metrics', headers: credentials });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(observed, []);
    policy = { mode: 'callback_allowlist', allowedCallbackRoutes: ['GET /api/callbacks/get-recall-metrics'] };
    const admitted = await app.inject({
      method: 'GET',
      url: '/api/callbacks/get-recall-metrics',
      headers: credentials,
    });
    assert.equal(admitted.statusCode, 200);
    assert.deepEqual(observed, [{ method: 'GET', url: '/api/recall/metrics?days=30', actor: 'default-user' }]);
  });

  it('runs the registered MCP handler over HTTP to the same canonical aggregate', async (t) => {
    useInvocationAuth(t);
    const oldUrl = process.env.CAT_CAFE_API_URL;
    t.after(() => {
      if (oldUrl === undefined) delete process.env.CAT_CAFE_API_URL;
      else process.env.CAT_CAFE_API_URL = oldUrl;
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    process.env.CAT_CAFE_API_URL = `http://127.0.0.1:${app.server.address().port}`;
    process.env.CAT_CAFE_INVOCATION_ID = 'metrics-inv';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'metrics-token';
    const query = { days: 30, catId: 'codex61-sol', toolName: 'cat_cafe_search_evidence' };
    const canonical = await app.inject({
      method: 'GET',
      url: '/api/recall/metrics?days=30&catId=codex61-sol&toolName=cat_cafe_search_evidence',
      headers: { 'x-cat-cafe-user': 'default-user' },
    });
    const before = db.prepare('SELECT total_changes() AS n').get().n;
    observed.length = 0;
    const tool = createServer()._registeredTools.cat_cafe_get_recall_metrics;
    const result = await tool.handler(tool.inputSchema.parse(query), { signal: new AbortController().signal });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), canonical.json());
    assert.equal(canonical.json().totalEvents, 1);
    assert.deepEqual(observed, [
      {
        method: 'GET',
        url: '/api/recall/metrics?days=30&catId=codex61-sol&toolName=cat_cafe_search_evidence',
        actor: 'default-user',
      },
    ]);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);

    const insert = db.prepare(`INSERT INTO recall_events (recall_id, cat_id, tool_name, invocation_id, query,
      mode, scope, candidates_json, consumed_json, reformulated, fell_back_to_grep, abandoned,
      next_graph_resolve_after_read, token_cost, timestamp)
      SELECT ?, ?, ?, invocation_id, query, mode, scope, candidates_json, consumed_json, reformulated,
        fell_back_to_grep, abandoned, next_graph_resolve_after_read, token_cost, timestamp
      FROM recall_events WHERE recall_id = 'metrics-event'`);
    insert.run('colon-left-1', 'a:b', 'c');
    insert.run('colon-left-2', 'a:b', 'c');
    insert.run('colon-right', 'a', 'b:c');
    const seededChanges = db.prepare('SELECT total_changes() AS n').get().n;
    for (const [filters, events] of [
      [{ catId: 'a:b', toolName: 'c' }, 2],
      [{ catId: 'a', toolName: 'b:c' }, 1],
    ]) {
      const filtered = await tool.handler({ days: 30, ...filters }, { signal: new AbortController().signal });
      assert.equal(filtered.isError, undefined);
      const report = JSON.parse(filtered.content[0].text);
      assert.deepEqual(report.filters, filters, 'distinct filter tuples cannot share a cached report');
      assert.equal(report.totalEvents, events);
    }
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, seededChanges);
    const callsBeforeDenied = observed.length;
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'invalid';
    const denied = await tool.handler(query, { signal: new AbortController().signal });
    assert.equal(denied.isError, true);
    assert.equal(observed.length, callsBeforeDenied);
    const definition = CANONICAL_TOOL_REGISTRY.find((item) => item.name === 'cat_cafe_get_recall_metrics');
    assert.equal(definition.policy.resourceFamily, 'recall-metrics');
    assert.deepEqual(definition.operation.boundary.risk, { level: 'read', openWorld: false });
    assert.deepEqual(definition.operation.boundary.authorizationPaths[0].scope, { kind: 'local-runtime' });
    assert.deepEqual(definition.policy.runtimeProfiles, ['full', 'readonly']);
  });

  it('rejects unknown parameters and out-of-range windows without a canonical read', async () => {
    for (const query of [
      'days=0',
      'days=91',
      'days=1.5',
      'days=30&url=http://example.invalid',
      'days=',
      'days=1&days=2',
      'method=POST',
      'userId=other',
      'refresh=1',
      `catId=${'x'.repeat(129)}`,
    ]) {
      const result = await app.inject({
        method: 'GET',
        url: `/api/callbacks/get-recall-metrics?${query}`,
        headers: credentials,
      });
      assert.equal(result.statusCode, 400, query);
    }
    assert.deepEqual(observed, []);
  });
});
