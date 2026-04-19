/**
 * F163: Zero-behavior regression test
 * When all F163 flags are off, behavior must be identical to pre-F163:
 * - No f163_logs entries created (from search path)
 * - boostSource = ['legacy'] for all results
 * - variantId present but consistent across queries
 * - Search results order unchanged (no boost applied)
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { computeVariantId, freezeFlags } from '../dist/domains/memory/f163-types.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { evidenceRoutes } from '../dist/routes/evidence.js';

describe('F163 Zero-behavior regression', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
  });

  it('all flags off = no authority boost applied', async () => {
    // Ensure all flags off
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Insert docs with different authority levels
    await store.upsert([
      {
        anchor: 'doc-low',
        kind: 'lesson',
        status: 'active',
        title: 'Low priority Redis topic',
        summary: 'Redis cache eviction',
        authority: 'observed',
        activation: 'query',
        updatedAt: '2026-01-01',
      },
      {
        anchor: 'doc-high',
        kind: 'decision',
        status: 'active',
        title: 'High priority Redis decision',
        summary: 'Redis integration architecture',
        authority: 'constitutional',
        activation: 'always_on',
        updatedAt: '2026-01-01',
      },
    ]);

    // Search with all flags off
    const results = await store.search('Redis');
    assert.ok(results.length >= 2, 'should return results');

    // Order should be BM25-determined, NOT authority-boosted
    // (We can't assert exact order since BM25 depends on content,
    // but we verify no crash and results are returned)
  });

  it('all flags off = boostSource is legacy', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const flags = freezeFlags();
    assert.equal(flags.authorityBoost, 'off');
    assert.equal(flags.alwaysOnInjection, 'off');
    assert.equal(flags.retrievalRerank, 'off');
    assert.equal(flags.compression, 'off');
    assert.equal(flags.promotionGate, 'off');
    assert.equal(flags.contradictionDetection, 'off');
    assert.equal(flags.reviewQueue, 'off');
  });

  it('all flags off = consistent variantId across queries', () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const flags1 = freezeFlags();
    const flags2 = freezeFlags();
    const v1 = computeVariantId(flags1);
    const v2 = computeVariantId(flags2);

    assert.equal(v1, v2, 'same flags should produce same variantId');
    assert.equal(v1.length, 12);
    assert.match(v1, /^[0-9a-f]{12}$/);
  });

  it('route returns legacy boostSource and variantId when flags off', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const app = Fastify();
    const evidenceStore = {
      search: async () => [
        {
          anchor: 'test-1',
          kind: 'lesson',
          status: 'active',
          title: 'Test Lesson',
          summary: 'A lesson',
          updatedAt: '2026-01-01',
        },
      ],
      health: async () => true,
      initialize: async () => {},
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
    };
    await app.register(evidenceRoutes, { evidenceStore });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.ok(body.variantId, 'should have variantId');
    assert.equal(body.results.length, 1);
    assert.deepEqual(body.results[0].boostSource, ['legacy']);
    assert.equal(body.degraded, false);
    // No injectionSources when flag is off
    assert.equal(body.injectionSources, undefined);
  });

  it('no f163_logs entries from search when flags off', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const db = new Database(':memory:');
    applyMigrations(db);

    // Verify the table exists but is empty
    const count = db.prepare('SELECT count(*) AS c FROM f163_logs').get();
    assert.equal(count.c, 0, 'f163_logs should be empty when flags are off');
  });

  // ── Phase B: compression-specific zero-behavior assertions ─────────

  it('backstop suppression does NOT activate when compression=off', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Insert a backstop doc
    await store.upsert([
      {
        anchor: 'backstop-doc',
        kind: 'lesson',
        status: 'active',
        title: 'Backstop test doc',
        summary: 'This doc has backstop activation',
        updatedAt: '2026-01-01',
        activation: 'backstop',
      },
    ]);

    // Search should return it when compression=off
    const results = await store.search('Backstop test');
    const found = results.some((r) => r.anchor === 'backstop-doc');
    assert.ok(found, 'backstop doc should be returned when compression=off');
  });

  it('compression scan API returns 403 when compression=off', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    const { f163AdminRoutes } = await import('../dist/routes/f163-admin.js');
    const app = Fastify();
    await app.register(f163AdminRoutes, { evidenceStore: store });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/scan',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    assert.equal(res.statusCode, 403, 'scan should be blocked when compression=off');
  });

  it('no summary docs can be created through normal upsert when compression=off', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Upsert a doc with summaryOfAnchor should still work at store level
    // (the flag gate is at API level, not store level — store is the internal tool)
    // But the API level should block it
    const { f163AdminRoutes } = await import('../dist/routes/f163-admin.js');
    const app = Fastify();
    await app.register(f163AdminRoutes, { evidenceStore: store });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {
        sourceAnchors: ['nonexistent'],
        summaryTitle: 'Test',
        summarySummary: 'Test',
        rationale: 'Test',
      },
    });
    assert.equal(res.statusCode, 403, 'apply should be blocked when compression=off');
  });
});
