/**
 * F163 Phase B Task 4: Compression scan API (AC-B1)
 * POST /api/f163/compress/scan — runs DuplicateScanner, returns suggestions.
 * Flag-gated: only when F163_COMPRESSION !== 'off'. Localhost-only.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { f163AdminRoutes } from '../../dist/routes/f163-admin.js';

describe('F163 compression scan API (AC-B1)', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
  });

  async function setup(compressionFlag) {
    if (compressionFlag) process.env.F163_COMPRESSION = compressionFlag;

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Seed some docs
    await store.upsert([
      {
        anchor: 'LL-001',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix EVAL behavior',
        summary: 'keyPrefix not applied to EVAL commands in ioredis',
        updatedAt: '2026-04-16',
      },
      {
        anchor: 'LL-002',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix ignored by EVAL',
        summary: 'ioredis EVAL and EVALSHA bypass keyPrefix',
        updatedAt: '2026-04-16',
      },
      {
        anchor: 'LL-003',
        kind: 'lesson',
        status: 'active',
        title: 'SQLite WAL mode',
        summary: 'WAL improves read concurrency',
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
      url: '/api/f163/compress/scan',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    assert.equal(res.statusCode, 403);
    const body = res.json();
    assert.ok(body.error.includes('compression'));
  });

  it('returns 403 when F163_COMPRESSION not set (defaults to off)', async () => {
    const { app } = await setup(null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/scan',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns suggestions when F163_COMPRESSION=suggest', async () => {
    const { app } = await setup('suggest');
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/scan',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: { threshold: 0.2 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.suggestions), 'should return suggestions array');
  });

  it('returns suggestions when F163_COMPRESSION=apply', async () => {
    const { app } = await setup('apply');
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/scan',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: { threshold: 0.2 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.suggestions));
  });

  it('rejects non-localhost requests', async () => {
    const { app } = await setup('suggest');
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/scan',
      headers: { 'x-forwarded-for': '192.168.1.100' },
      remoteAddress: '192.168.1.100',
    });
    assert.equal(res.statusCode, 403);
  });

  it('logs compression_scan to f163_logs (R1 P2)', async () => {
    const { app, store } = await setup('suggest');
    await app.inject({
      method: 'POST',
      url: '/api/f163/compress/scan',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: { threshold: 0.3 },
    });

    const db = store.getDb();
    const rows = db.prepare("SELECT * FROM f163_logs WHERE log_type = 'compression_scan'").all();
    assert.ok(rows.length >= 1, 'scan should log to f163_logs');
    const payload = JSON.parse(rows[0].payload);
    assert.ok('clustersFound' in payload, 'payload should have clustersFound');
  });

  it('variant_id is deterministic and hex-only (R2 P1)', async () => {
    const { app, store } = await setup('suggest');
    await app.inject({
      method: 'POST',
      url: '/api/f163/compress/scan',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: { threshold: 0.3 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/f163/compress/scan',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: { threshold: 0.3 },
    });

    const db = store.getDb();
    const rows = db.prepare("SELECT variant_id FROM f163_logs WHERE log_type = 'compression_scan'").all();
    assert.ok(rows.length >= 2, 'need at least 2 log rows');
    assert.equal(rows[0].variant_id, rows[1].variant_id, 'same flags must produce same variant_id');
    assert.match(rows[0].variant_id, /^[0-9a-f]{12}$/, 'variant_id must be 12-char hex');
  });
});
