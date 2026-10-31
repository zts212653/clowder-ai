/**
 * F263 Phase C — AC-C2: Three-axis lifecycle API routes
 *
 * Verifies:
 * 1. GET /api/recall/lifecycle/three-axis returns snapshot with maturity labels
 * 2. GET /api/recall/lifecycle/verification-events returns events
 * 3. GET /api/recall/lifecycle/traces returns filtered traces
 * 4. Auth enforcement (401)
 * 5. Graceful degradation when V33 not applied
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const AUTH_HEADER = { 'X-Cat-Cafe-User': 'user-test' };
const NOW = Date.now();

describe('F263 Phase C: three-axis lifecycle routes', () => {
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

    app = Fastify();
    await app.register(recallMetricsRoutes, {
      evidenceDb: db,
      threadStore: {
        get: async (id) => {
          if (id === 'thread-1') return { id, userId: 'user-test', createdBy: 'user-test' };
          if (id === 'thread-2') return { id, userId: 'user-other', createdBy: 'user-other' };
          return null;
        },
        list: async (userId) => {
          if (userId === 'user-test') return [{ id: 'thread-1' }];
          if (userId === 'user-other') return [{ id: 'thread-2' }];
          return [];
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) db.close();
  });

  // ── Three-axis endpoint ────────────────────────────────────────────

  describe('GET /api/recall/lifecycle/three-axis', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/recall/lifecycle/three-axis' });
      assert.equal(res.statusCode, 401);
    });

    it('returns no-data snapshot when no traces exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/three-axis?days=7',
        headers: AUTH_HEADER,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.days, 7);
      assert.equal(body.harmfulConsumption.value, 0);
      assert.equal(body.harmfulConsumption.maturity, 'no-data');
      assert.ok(body.harmfulConsumption.reason, 'no-data should explain why');
      assert.equal(body.unmetDemandLowerBound.value, 0);
      assert.equal(body.unmetDemandLowerBound.maturity, 'no-data');
      assert.equal(body.attentionCost.value, 0);
      assert.equal(body.attentionCost.maturity, 'no-data');
      // Forbidden: no total score
      assert.equal(body.totalScore, undefined);
      assert.equal(body.score, undefined);
    });

    it('returns measured values when traces exist in user thread', async () => {
      const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);
      const store = new LifecycleTraceStore(db);
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        threadId: 'thread-1',
        observedAt: NOW - 1000,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/three-axis?days=7',
        headers: AUTH_HEADER,
      });
      const body = res.json();
      assert.equal(body.harmfulConsumption.value, 1);
      assert.equal(body.harmfulConsumption.maturity, 'measured');
    });
  });

  // ── Verification events endpoint ──────────────────────────────────

  describe('GET /api/recall/lifecycle/verification-events', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/recall/lifecycle/verification-events' });
      assert.equal(res.statusCode, 401);
    });

    it('returns empty array when no events exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/verification-events?days=30',
        headers: AUTH_HEADER,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.events, []);
    });

    it('returns verification events only from user threads', async () => {
      const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);
      const store = new LifecycleTraceStore(db);
      store.append({
        kind: 'verification',
        sourceFamily: 'search_evidence',
        targetAnchor: 'docs/test.md',
        claimKind: 'stale-pointer',
        checkSource: 'file-check',
        verdict: 'confirmed',
        threadId: 'thread-1',
        recallId: 'r-ver-1',
        observedAt: NOW - 1000,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/verification-events?days=7',
        headers: AUTH_HEADER,
      });
      const body = res.json();
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].target, 'docs/test.md');
      assert.equal(body.events[0].verdict, 'confirmed');
    });

    it('filters by target when provided', async () => {
      const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);
      const store = new LifecycleTraceStore(db);
      store.append({
        kind: 'verification',
        sourceFamily: 'search_evidence',
        targetAnchor: 'a1',
        claimKind: 'test',
        checkSource: 'test',
        verdict: 'confirmed',
        threadId: 'thread-1',
        recallId: 'r-tgt-1',
        observedAt: NOW,
      });
      store.append({
        kind: 'verification',
        sourceFamily: 'search_evidence',
        targetAnchor: 'a2',
        claimKind: 'test',
        checkSource: 'test',
        verdict: 'refuted',
        threadId: 'thread-1',
        recallId: 'r-tgt-2',
        observedAt: NOW,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/verification-events?target=a1&days=7',
        headers: AUTH_HEADER,
      });
      const body = res.json();
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].target, 'a1');
    });
  });

  // ── Traces endpoint ────────────────────────────────────────────────

  describe('GET /api/recall/lifecycle/traces', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/recall/lifecycle/traces' });
      assert.equal(res.statusCode, 401);
    });

    it('filters by kind and category within user threads', async () => {
      const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);
      const store = new LifecycleTraceStore(db);
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        threadId: 'thread-1',
        observedAt: NOW,
      });
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        threadId: 'thread-1',
        recallId: 'r-kind-1',
        observedAt: NOW,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/traces?kind=harmful_consumption&days=7',
        headers: AUTH_HEADER,
      });
      const body = res.json();
      assert.equal(body.traces.length, 1);
      assert.equal(body.traces[0].kind, 'harmful_consumption');
    });
  });

  // ── P0 fix: cross-user trace isolation (two-user negative test) ────

  describe('P0 fix: cross-user trace isolation', () => {
    it('user-a trace is NOT visible to user-b on three-axis', async () => {
      const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);
      const store = new LifecycleTraceStore(db);
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        threadId: 'thread-1',
        observedAt: NOW - 1000,
      });

      // user-test sees the trace
      const resA = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/three-axis?days=7',
        headers: { 'X-Cat-Cafe-User': 'user-test' },
      });
      assert.equal(resA.json().harmfulConsumption.value, 1);

      // user-other does NOT see the trace
      const resB = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/three-axis?days=7',
        headers: { 'X-Cat-Cafe-User': 'user-other' },
      });
      assert.equal(resB.json().harmfulConsumption.value, 0, 'user-other must NOT see user-test traces');
    });

    it('user-a queryText NOT visible to user-b on /traces', async () => {
      const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);
      const store = new LifecycleTraceStore(db);
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        threadId: 'thread-1',
        recallId: 'r-cross-1',
        queryText: 'sensitive query from user-test',
        observedAt: NOW,
      });

      const resA = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/traces?kind=unmet_demand&days=7',
        headers: { 'X-Cat-Cafe-User': 'user-test' },
      });
      assert.equal(resA.json().traces.length, 1);

      const resB = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/traces?kind=unmet_demand&days=7',
        headers: { 'X-Cat-Cafe-User': 'user-other' },
      });
      assert.equal(resB.json().traces.length, 0, 'user-other must NOT see user-test traces');
    });

    it('user-a verification events NOT visible to user-b', async () => {
      const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);
      const store = new LifecycleTraceStore(db);
      store.append({
        kind: 'verification',
        sourceFamily: 'search_evidence',
        targetAnchor: 'docs/secret.md',
        claimKind: 'stale-pointer',
        checkSource: 'file-check',
        verdict: 'confirmed',
        threadId: 'thread-1',
        recallId: 'r-cross-ver',
        observedAt: NOW,
      });

      const resA = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/verification-events?days=7',
        headers: { 'X-Cat-Cafe-User': 'user-test' },
      });
      assert.equal(resA.json().events.length, 1);

      const resB = await app.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/verification-events?days=7',
        headers: { 'X-Cat-Cafe-User': 'user-other' },
      });
      assert.equal(resB.json().events.length, 0, 'user-other must NOT see user-test verification events');
    });

    it('503 when threadStore is unavailable (fail-closed)', async () => {
      const Fastify = (await import('fastify')).default;
      const { recallMetricsRoutes } = await import(`../../dist/routes/recall-metrics.js?v=${Date.now()}`);
      const noThreadApp = Fastify();
      await noThreadApp.register(recallMetricsRoutes, { evidenceDb: db });
      await noThreadApp.ready();

      const res = await noThreadApp.inject({
        method: 'GET',
        url: '/api/recall/lifecycle/three-axis?days=7',
        headers: AUTH_HEADER,
      });
      assert.equal(res.statusCode, 503);
      await noThreadApp.close();
    });
  });
});
