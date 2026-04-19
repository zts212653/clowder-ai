/**
 * F163 Phase B Task 5: Compression apply API (AC-B2)
 * POST /api/f163/compress/apply — create canonical summary + demote originals to backstop.
 * Flag-gated: only when F163_COMPRESSION === 'apply'. Localhost-only.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { f163AdminRoutes } from '../../dist/routes/f163-admin.js';

describe('F163 compression apply API (AC-B2)', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
  });

  async function setup(compressionFlag) {
    if (compressionFlag) process.env.F163_COMPRESSION = compressionFlag;

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Seed 3 original docs
    await store.upsert([
      {
        anchor: 'LL-A01',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix EVAL',
        summary: 'keyPrefix ignored by EVAL',
        updatedAt: '2026-04-16',
      },
      {
        anchor: 'LL-A02',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix EVALSHA',
        summary: 'keyPrefix ignored by EVALSHA',
        updatedAt: '2026-04-16',
      },
      {
        anchor: 'LL-A03',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix scripting',
        summary: 'keyPrefix not applied to scripting commands',
        updatedAt: '2026-04-16',
      },
    ]);

    const app = Fastify();
    await app.register(f163AdminRoutes, { evidenceStore: store });
    await app.ready();
    return { app, store };
  }

  it('returns 403 when F163_COMPRESSION=off', async () => {
    const { app } = await setup('off');
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {
        sourceAnchors: ['LL-A01', 'LL-A02'],
        summaryTitle: 'Redis keyPrefix scripting summary',
        summarySummary: 'Consolidated lesson',
        rationale: 'Duplicate lessons',
      },
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns 403 when F163_COMPRESSION=suggest (only apply allowed)', async () => {
    const { app } = await setup('suggest');
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {
        sourceAnchors: ['LL-A01', 'LL-A02'],
        summaryTitle: 'Summary',
        summarySummary: 'Consolidated',
        rationale: 'Duplicates',
      },
    });
    assert.equal(res.statusCode, 403);
  });

  it('creates summary and demotes originals when F163_COMPRESSION=apply', async () => {
    const { app, store } = await setup('apply');
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {
        sourceAnchors: ['LL-A01', 'LL-A02', 'LL-A03'],
        summaryTitle: 'Redis keyPrefix scripting behavior',
        summarySummary: 'keyPrefix is not applied to EVAL/EVALSHA scripting commands',
        rationale: 'Three duplicate lessons about the same keyPrefix scripting behavior',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.ok);
    assert.ok(body.summaryAnchor, 'should return summary anchor');

    // Verify summary doc
    const summary = await store.getByAnchor(body.summaryAnchor);
    assert.ok(summary);
    assert.equal(summary.title, 'Redis keyPrefix scripting behavior');
    assert.deepEqual(summary.sourceIds, ['LL-A01', 'LL-A02', 'LL-A03']);
    assert.ok(summary.summaryOfAnchor);
    assert.equal(summary.authority, 'validated');
    assert.equal(summary.activation, 'query');
    assert.equal(summary.kind, 'lesson');

    // Verify originals demoted to backstop
    for (const anchor of ['LL-A01', 'LL-A02', 'LL-A03']) {
      const doc = await store.getByAnchor(anchor);
      assert.ok(doc);
      assert.equal(doc.activation, 'backstop', `${anchor} should be backstop`);
    }
  });

  it('rejects when source anchor does not exist', async () => {
    const { app } = await setup('apply');
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {
        sourceAnchors: ['LL-A01', 'NONEXISTENT'],
        summaryTitle: 'Summary',
        summarySummary: 'Consolidated',
        rationale: 'Merge',
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.error.includes('NONEXISTENT'));
  });

  it('logs compression_apply to f163_logs (R1 P2)', async () => {
    const { app, store } = await setup('apply');
    await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {
        sourceAnchors: ['LL-A01', 'LL-A02'],
        summaryTitle: 'Logging test summary',
        summarySummary: 'Merged for logging test',
        rationale: 'Test logging',
      },
    });

    const db = store.getDb();
    const rows = db.prepare("SELECT * FROM f163_logs WHERE log_type = 'compression_apply'").all();
    assert.ok(rows.length >= 1, 'apply should log to f163_logs');
    const payload = JSON.parse(rows[0].payload);
    assert.ok('summaryAnchor' in payload, 'payload should have summaryAnchor');
    assert.ok('sourceAnchors' in payload, 'payload should have sourceAnchors');
  });

  it('variant_id is deterministic and hex-only (R2 P1)', async () => {
    const { app, store } = await setup('apply');
    await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {
        sourceAnchors: ['LL-A01', 'LL-A02'],
        summaryTitle: 'First apply',
        summarySummary: 'First merge',
        rationale: 'Dedup',
      },
    });

    const db = store.getDb();
    const rows = db.prepare("SELECT variant_id FROM f163_logs WHERE log_type = 'compression_apply'").all();
    assert.ok(rows.length >= 1, 'need at least 1 apply log row');
    assert.match(rows[0].variant_id, /^[0-9a-f]{12}$/, 'variant_id must be 12-char hex (no UUID dashes)');
  });

  it('rejects single source compression (R1 P2)', async () => {
    const { app } = await setup('apply');
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {
        sourceAnchors: ['LL-A01'],
        summaryTitle: 'Single source summary',
        summarySummary: 'Only one source',
        rationale: 'No merge needed',
      },
    });
    assert.equal(res.statusCode, 400, 'single source compression should be rejected');
  });

  it('rejects cascade (source is already a summary)', async () => {
    const { app, store } = await setup('apply');

    // First compression
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {
        sourceAnchors: ['LL-A01', 'LL-A02'],
        summaryTitle: 'First summary',
        summarySummary: 'First merge',
        rationale: 'Duplicates',
      },
    });
    assert.equal(res1.statusCode, 200);
    const summaryAnchor = res1.json().summaryAnchor;

    // Attempt to compress the summary
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {
        sourceAnchors: [summaryAnchor, 'LL-A03'],
        summaryTitle: 'Second summary',
        summarySummary: 'Second merge',
        rationale: 'Further merge',
      },
    });
    assert.equal(res2.statusCode, 400);
    const body = res2.json();
    assert.ok(body.error.includes('cascade'));
  });
});
