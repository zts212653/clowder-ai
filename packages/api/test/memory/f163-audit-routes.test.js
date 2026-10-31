/**
 * F163 Phase C Tasks 4-7: Audit routes — contradiction check, flag-review, review-queue, health-report
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { f163AuditRoutes } from '../../dist/routes/f163-audit-routes.js';

const SAVED_ENV = {};

function saveEnv() {
  for (const k of ['F163_CONTRADICTION_DETECTION', 'F163_REVIEW_QUEUE']) {
    SAVED_ENV[k] = process.env[k];
  }
}

function restoreEnv() {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function setup(opts = {}) {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();

  if (opts.seed) {
    await store.upsert(opts.seed);
  }

  const app = Fastify();
  await app.register(f163AuditRoutes, { evidenceStore: store });
  await app.ready();
  return { app, store };
}

const LOCALHOST = { 'x-forwarded-for': '127.0.0.1' };

// ── Task 4: POST /api/f163/contradictions/check ──────────────────────

describe('POST /api/f163/contradictions/check', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('returns contradiction hits when flag=apply', async () => {
    process.env.F163_CONTRADICTION_DETECTION = 'apply';
    const { app } = await setup({
      seed: [
        {
          anchor: 'LL-001',
          kind: 'lesson',
          status: 'active',
          title: 'Redis EVAL ignores keyPrefix',
          summary: 'keyPrefix not applied to EVAL commands in ioredis',
          updatedAt: '2026-04-10',
        },
      ],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/contradictions/check',
      headers: LOCALHOST,
      payload: {
        title: 'Redis EVAL respects keyPrefix',
        summary: 'keyPrefix IS applied to EVAL in latest ioredis',
        kind: 'lesson',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.hits));
    assert.ok(body.hits.length >= 1, `expected ≥1 hit, got ${body.hits.length}`);
  });

  it('returns 403 when flag=off', async () => {
    process.env.F163_CONTRADICTION_DETECTION = 'off';
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/contradictions/check',
      headers: LOCALHOST,
      payload: { title: 'test', summary: 'test', kind: 'lesson' },
    });
    assert.equal(res.statusCode, 403);
  });
});

// ── Task 5: POST /api/f163/flag-review ───────────────────────────────

describe('POST /api/f163/flag-review', () => {
  it('marks doc status=review', async () => {
    const { app, store } = await setup({
      seed: [
        {
          anchor: 'LL-001',
          kind: 'lesson',
          status: 'active',
          title: 'Some lesson',
          updatedAt: '2026-04-10',
        },
      ],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/flag-review',
      headers: LOCALHOST,
      payload: { anchor: 'LL-001', reason: 'Observed contradictory behavior in production' },
    });
    assert.equal(res.statusCode, 200);
    const doc = await store.getByAnchor('LL-001');
    assert.equal(doc.status, 'review');
  });

  it('rejects when anchor not found', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/flag-review',
      headers: LOCALHOST,
      payload: { anchor: 'NONEXISTENT', reason: 'test' },
    });
    assert.equal(res.statusCode, 404);
  });
});

// ── Task 6: GET /api/f163/review-queue ───────────────────────────────

describe('GET /api/f163/review-queue', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('returns items where verified_at exceeds review_cycle_days', async () => {
    process.env.F163_REVIEW_QUEUE = 'apply';
    const { app } = await setup({
      seed: [
        {
          anchor: 'LL-STALE',
          kind: 'lesson',
          status: 'active',
          title: 'Old knowledge',
          updatedAt: '2026-01-01',
          verifiedAt: '2026-01-01',
          reviewCycleDays: 90,
        },
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/f163/review-queue',
      headers: LOCALHOST,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.items.length >= 1, `expected ≥1 stale item, got ${body.items.length}`);
    assert.equal(body.items[0].anchor, 'LL-STALE');
    assert.equal(body.items[0].staleness, 'overdue');
  });

  it('returns 403 when F163_REVIEW_QUEUE=off', async () => {
    process.env.F163_REVIEW_QUEUE = 'off';
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/f163/review-queue',
      headers: LOCALHOST,
    });
    assert.equal(res.statusCode, 403);
  });
});

// ── Task 7: GET /api/f163/health-report ──────────────────────────────

describe('GET /api/f163/health-report', () => {
  it('returns aggregated metrics', async () => {
    const { app } = await setup({
      seed: [
        {
          anchor: 'LL-1',
          kind: 'lesson',
          status: 'active',
          title: 'Lesson 1',
          updatedAt: '2026-04-10',
        },
        {
          anchor: 'DD-1',
          kind: 'decision',
          status: 'active',
          title: 'Decision 1',
          updatedAt: '2026-04-10',
        },
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/f163/health-report',
      headers: LOCALHOST,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.totalDocs, 2);
    assert.equal(body.byKind.lesson, 1);
    assert.equal(body.byKind.decision, 1);
    assert.ok('contradictions' in body);
    assert.ok('staleReview' in body);
    assert.ok('backstopRatio' in body);
    assert.ok('compressionRatio' in body);
  });
});
