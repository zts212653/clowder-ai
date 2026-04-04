/**
 * Tool Usage Routes Tests — F150 (#339)
 * GET /api/usage/tools returns aggregated tool/skill/MCP usage.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

const AUTH_HEADER = { 'X-Cat-Cafe-User': 'user-1' };

/** Minimal fake Redis (same as counter test). */
function createFakeRedis() {
  const store = new Map();
  return {
    _store: store,
    async incr(key) {
      const cur = parseInt(store.get(key) ?? '0', 10);
      const next = cur + 1;
      store.set(key, String(next));
      return next;
    },
    async expire() {},
    async scan(cursor, _mf, pattern, _cf, _c) {
      if (cursor !== '0') return ['0', []];
      const glob = pattern.replace('*', '');
      const matched = [];
      for (const k of store.keys()) {
        if (k.startsWith(glob)) matched.push(k);
      }
      return ['0', matched];
    },
    async mget(...keys) {
      return keys.map((k) => store.get(k) ?? null);
    },
  };
}

describe('GET /api/usage/tools', () => {
  let app;
  let fakeRedis;

  beforeEach(async () => {
    const Fastify = (await import('fastify')).default;
    const { toolUsageRoutes, clearToolUsageCache } = await import('../dist/routes/tool-usage.js');
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');

    clearToolUsageCache();
    fakeRedis = createFakeRedis();
    const counter = new ToolUsageCounter(fakeRedis);

    // Seed: native + MCP (both formats) + skill
    counter.recordToolUse('opus', 'Read');
    counter.recordToolUse('opus', 'Read');
    counter.recordToolUse('opus', 'Edit');
    counter.recordToolUse('codex', 'mcp__cat-cafe__post_message');
    counter.recordToolUse('codex', 'mcp:cat-cafe/search_evidence');
    counter.recordToolUse('opus', 'Skill', { skill: 'tdd' });
    await new Promise((r) => setTimeout(r, 80));

    app = Fastify({ logger: false });
    await app.register(toolUsageRoutes, { toolUsageCounter: counter });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test('returns 401 without auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/usage/tools?days=1' });
    assert.equal(res.statusCode, 401);
  });

  test('returns 200 with correct report structure', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/usage/tools?days=1', headers: AUTH_HEADER });
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.payload);
    assert.ok(body.period);
    assert.ok(body.summary);
    assert.equal(body.summary.totalCalls, 6);
    assert.equal(body.summary.byCategory.native, 3);
    assert.equal(body.summary.byCategory.mcp, 2);
    assert.equal(body.summary.byCategory.skill, 1);
    assert.ok(Array.isArray(body.topTools));
    assert.ok(Array.isArray(body.daily));
    assert.ok(body.byCat.opus);
    assert.ok(body.byCat.codex);
  });

  test('filters by catId', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/usage/tools?days=1&catId=codex', headers: AUTH_HEADER });
    const body = JSON.parse(res.payload);
    assert.equal(body.summary.totalCalls, 2);
    assert.equal(body.summary.byCategory.mcp, 2);
  });

  test('filters by category', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/tools?days=1&category=skill',
      headers: AUTH_HEADER,
    });
    const body = JSON.parse(res.payload);
    assert.equal(body.summary.totalCalls, 1);
    assert.equal(body.summary.byCategory.skill, 1);
  });

  test('rejects invalid category', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/usage/tools?category=invalid', headers: AUTH_HEADER });
    assert.equal(res.statusCode, 400);
  });

  test('defaults to 7 days', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/usage/tools', headers: AUTH_HEADER });
    const body = JSON.parse(res.payload);
    assert.ok(body.period);
    const fromDate = new Date(body.period.from);
    const toDate = new Date(body.period.to);
    const diffDays = (toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000);
    assert.ok(diffDays >= 5 && diffDays <= 7);
  });
});
